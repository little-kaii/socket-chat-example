import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

if (cluster.isPrimary) {
    const numCPUs = availableParallelism();

    // create one worker per available core
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
            PORT: 3000 + i,
        });
    }

    // set up the adapter on the primary thread
    setupPrimary();
} else {
    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
        connectionStateRecovery: {},
        adapter: createAdapter(),
    });

    const __dirname = dirname(fileURLToPath(import.meta.url));

    app.use("/assets", express.static(join(__dirname, "public/assets")));

    // open the database file
    const db = await open({
        filename: "chat.db",
        driver: sqlite3.Database,
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_offset TEXT UNIQUE,
            content TEXT
        )
    `);

    app.get("/", (req, res) => {
        res.sendFile(join(__dirname, "index.html"));
    });

    app.get("*", (req, res) => {
        res.redirect("/");
    });

    io.on("connection", async (socket) => {
        socket.on("chat-message", async (msg, clientOffset, callback) => {
            let result;
            try {
                const query =
                    "INSERT INTO messages (content, client_offset) VALUES (?, ?)";
                result = await db.run(query, msg, clientOffset);
            } catch (error) {
                // console.error("error", error);
                if (error.errno === 19) {
                    callback();
                } else {
                }
                return;
            }
            io.emit("chat-message", msg, result.lastID);
            callback();
        });

        if (!socket.recovered) {
            // if the connection state recovery was not successful
            try {
                const query = "SELECT id, content FROM messages WHERE id > ?";
                await db.each(
                    query,
                    [socket.handshake.auth.serverOffset || 0],
                    (_err, row) => {
                        socket.emit("chat-message", row.content, row.id);
                    }
                );
            } catch (error) {
                console.log(error);
            }
        }

        socket.on("hello", (value, callback) => {
            console.log(value);
            callback();
        });
    });

    const port = process.env.PORT;

    server.listen(port, () => {
        console.log(`server running at http://localhost:${port}`);
    });
}
