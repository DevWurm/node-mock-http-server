var connect     = require('connect'),
    url         = require('url'),
    fs          = require('fs'),
    http        = require('http'),
    https       = require('https'),
    util        = require('util'),
    _           = require('underscore'),
    multiparty  = require('multiparty');

/**
 * @param {String} host     Server host
 * @param {String} port     Server port
 * @param {String} key      HTTPS key (if missing the server is HTTP)
 * @param {String} cert     HTTPS certificate (if missing the server is HTTP)
 */
function Server(host, port, key, cert)
{
    var server      = null,
        handlers    = [],
        connections = [];

    function _multipart(req, res, next) {

        if (req.method !== 'POST' && req.method !== 'PUT') {
            return next();
        }

        if ('multipart/form-data' !== (req.headers['content-type'] || '').split(';')[0]) {
            return next();
        }

        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {

            req.body  = {};
            req.files = {};

            if (err) { return next(); }

            _.each(fields, function(value, name){
                if (Array.isArray(value) && value.length === 1) {
                    req.body[name] = value[0];
                } else {
                    req.body[name] = value;
                }
            });

            _.each(files, function(value, name){
                if (Array.isArray(value) && value.length === 1) {
                    req.files[name] = value[0];
                } else {
                    req.files[name] = value;
                }
            });

            next();
        });
    }

    /**
     * Supports:
     * - { reply: { body: "data" }}
     * - { reply: { body: function(req) { return "data"; }}}
     * - { reply: { body: function(req, send) { setTimeout(function() { send("data"); }, 1000); }}}
     */
    function _getResponseBody(handler, req, callback) {
        // String
        if (!_(handler.reply.body).isFunction()) {
            return callback(handler.reply.body || "");
        }

        // Synch function
        if (handler.reply.body.length <= 1) {
            return callback(handler.reply.body(req) || "");
        }

        // Asynch function
        handler.reply.body(req, callback);
    }

    /**
     * Supports:
     * - { reply: { status: 200 }}
     * - { reply: { status: function(req) { return 200; }}}
     */
    function _getResponseStatus(handler, req, callback) {
        // Number
        if (!_(handler.reply.status).isFunction()) {
            return callback(handler.reply.status || 0);
        }

        // Synch function
        return callback(handler.reply.status(req) || 0);
    }

    function _handleMockedRequest(req, res, next) {

        var handled = false;

        _(handlers).each(function(handler) {

            // Parse request URL
            var reqParts = url.parse(req.url, true);
            req.pathname = reqParts.pathname;
            req.query    = reqParts.query;

            // Check if we can handle the request
            if (handled || (handler.when != "*" && req.method != handler.when.toUpperCase()) || reqParts.pathname != handler.on || (handler.filter && handler.filter(req) !== true)) {
                return;
            }

            // Flag as handled
            handled = true;

            // Get response status and body
            _getResponseBody(handler, req, function(content) {
                _getResponseStatus(handler, req, function(status) {

                    // Prepare response data
                    var encoding = Buffer.isBuffer(content) ? undefined : "utf8";
                    var length   = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf8");

                    // Prepare headers
                    var headersToSend = {};
                    var headers = _(handler.reply.headers)
                        .extend({ "content-length": length }, handler.reply.headersOverrides || {});

                    // Remove "null" values from headers
                    _(headers).each(function(value, name) {
                        if (value !== null) {
                            headersToSend[name] = value;
                        }
                    });

                    // Send response (supports delay)
                    setTimeout(function() {

                        // Send headers
                        res.writeHead(status, headersToSend);

                        // Send content
                        if (req.method != "HEAD") {
                            res.write(content, encoding);
                        }

                        // End response
                        res.end();

                    }, handler.delay || 0);

                });
            });
        });

        if (!handled) {
            next();
        }
    }

    function _handleDefaultRequest(req, res, next)
    {
        res.writeHead(404, {
            "content-type":   "plain/text",
            "content-length": 9
        });

        res.end("Not Found");
    }


    this.will = function(handler)
    {
        // Add default reply
        handler.reply         = _({}).extend({ "status": 200, "body": "" }, handler.reply);
        handler.reply.headers = _({}).extend({ "content-type": "application/json" }, handler.reply.headers);

        // Add default method
        handler = _({}).extend({ "when": "GET" }, handler);

        handlers.push(handler);
        return this;
    };

    this.start = function(callback)
    {
        // Create app stack
        var connectApp = connect()
            .use(_multipart)
            .use(_handleMockedRequest)
            .use(_handleDefaultRequest);

        // Create server
        if (key && cert) {
            server = https.createServer({key: key, cert: cert}, connectApp);
        } else {
            server = http.createServer(connectApp);
        }

        server.on("connection", function (connection) {
            connection.on("close", function () {
                connections = _(connections).without(connection);
            });

            connections.push(connection);
        });

        server.on("listening", function () {
            callback();
        });

        server.listen(port, host);
    };


    this.stop = function (callback) {

        if (!server) {
            return callback();
        }

        server.on("close", function() {
            server   = null;
            handlers = [];

            if (connections.length === 0) {
                return callback();
            }

            // Close connections
            _(connections).forEach(function (connection) {
                connection.on("close", function() {
                    connections = _(connections).without(connection);
                    if (connections.length === 0) {
                        callback();
                    }
                });

                connection.end();
            });
        });

        server.close();
    };

}

function ServerVoid() {

    this.will  = function() {};
    this.start = function(callback) { callback(); };
    this.stop  = function(callback) { callback(); };
}

/**
 * @param {Object} httpConfig
 * @param {Object} httpsConfig
 */
function ServerMock(httpConfig, httpsConfig)
{
    var httpServerMock  = httpConfig ?  new Server(httpConfig.host, httpConfig.port) : new ServerVoid();
    var httpsServerMock = httpsConfig ? new Server(httpsConfig.host, httpsConfig.port, httpsConfig.key, httpsConfig.cert) : new ServerVoid();


    this.will = function(handler)
    {
        httpServerMock.will(handler);
        httpsServerMock.will(handler);

        return this;
    };

    this.start = function(callback)
    {
        httpServerMock.start(function() {
            httpsServerMock.start(function() {
                callback();
            });
        });
    };

    this.stop = function(callback)
    {
        httpServerMock.stop(function() {
            httpsServerMock.stop(callback);
        });
    };

}


module.exports = ServerMock;