import { WebSocketServer } from "ws";
import { BlabberServer } from "./blabber.ts";
const server = new BlabberServer(new WebSocketServer({
	port: 2137,
	autoPong: true
}));;
server.logger.attach(console.log);
server.on('open', function(this: BlabberServer, port) {this.logger.info('server open on port', port)})
server.on('connection', function(this: BlabberServer, client) {this.logger.info('new connection', client.id)})
