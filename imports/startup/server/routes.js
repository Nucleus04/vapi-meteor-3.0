import { Meteor } from "meteor/meteor";
import { WebApp } from "meteor/webapp";
import connect from "connect";
import bodyParser from "body-parser";
import multer from "multer";

import Server from "../../api/classes/server/Server";
import Utilities from "../../api/classes/server/Utilities";

Meteor.startup(() => {
    const app = connect();

    // Middleware
    app.use(multer().any());
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));

    // Routes
    app.use("/api/info", async (req, res) => {
        try {
            const retval = await Server.Vapi.parseRequest(req.body);
            Utilities.showDebug("Response: ", JSON.stringify(retval));
            res.writeHead(retval.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify(retval.message));
        } catch (error) {
            console.error(error);
            res.statusCode = 500;
            res.end("Error: " + (error.message || error));
        }
    });

    app.use("/api/session", async (req, res) => {
        const session = Server.Vapi.createSession(req.body);
        if (!session) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end();
            return;
        }
        session.parseSession(req.body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end();
    });

    app.use("/receipt", async (req, res) => {
        Utilities.showDebug("Receipt: ", req.body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end();
    });

    // Attach the connect app to WebApp
    WebApp.connectHandlers.use(app);
});