import crypto from 'node:crypto';
import fs from 'node:fs';
import rl from 'node:readline/promises';
import process from 'node:process';
import { BlabberPacket, PacketDataMap, PacketType as BlabberPacketType, PacketType, PacketNameMap } from './blabber.ts';
import { EventEmitter } from 'node:events';
// import * as blabber_protocol from './blabber_protocol.ts';
import * as jabber_protocol from './jabber_protocol.ts';
import * as blabber_protocol from './blabber_protocol.ts';
import { MessageType } from "@protobuf-ts/runtime";
import { Buffer } from 'node:buffer';
import path from "node:path";
import * as uuid from 'uuid';

const te = new TextEncoder()
const RSA_PACKET_SIGNATURE = te.encode('JBRrsa');

class RSAData {
	static encrypt_public(key: crypto.KeyObject, buffer: Uint8Array): Uint8Array {
		if (!key.asymmetricKeyDetails)
			throw new Error('key not asymmetric');
		// console.log(key.asymmetricKeyDetails.modulusLength, crypto.constants.RSA_PKCS1_OAEP_PADDING)
		if (key.asymmetricKeyDetails.modulusLength === undefined)
			throw new Error('key.asymmetricKeyDetails.modulusLength is undefined');
		const chunk_size = (214); //  - crypto.constants.RSA_PKCS1_OAEP_PADDING

		const data: (Uint8Array | number[] | number)[] = [RSA_PACKET_SIGNATURE];
		data.push(0);
		data.push(buffer.length & 0xFF);
		data.push((buffer.length & 0xFF00) >> 8);
		let pointer = 0;
		while (pointer < buffer.length) {
			let slice = buffer.subarray(pointer, pointer + chunk_size);
			(data[1] as number)++;
			pointer += slice.length
			if(slice.length < chunk_size) {
				slice = new Uint8Array([...slice, ...new Array(chunk_size-slice.length).fill(0)])
			}
			// console.log(slice, slice.length, chunk_size)
			const ciphertext = crypto.publicEncrypt(key, slice);
			const ui8aciphertext = Jabber.buffer_to_uint8array(ciphertext);
			// console.log('length', ui8aciphertext.length, ui8aciphertext.length && 0xFF, (ui8aciphertext.length && 0x00FF) >> 8)
			data.push(ui8aciphertext.length & 0xFF)
			data.push((ui8aciphertext.length & 0xFF00) >> 8)
			data.push(ui8aciphertext)
		}
		return new Uint8Array(data.reduce<number[]>((p, c) => [...p, ...(typeof c === 'number' ? [c] : c)], []))
		// const uh = crypto.createPublicKey(key);
		// uh
		// key.asymmetricKeyDetails
		
		// crypto.publicEncrypt()
	}
	static decrypt_private(key: crypto.KeyObject, buffer: Uint8Array): Uint8Array {
		// console.log(buffer)
		if (compareuint8arrays(buffer.subarray(0, RSA_PACKET_SIGNATURE.length-1), RSA_PACKET_SIGNATURE))
			throw 'no rsa packet';
		let pointer = RSA_PACKET_SIGNATURE.length;
		let remaining_chunks = buffer[pointer++];
		const cleartext_len_low = buffer[pointer++];
		const cleartext_len_high = buffer[pointer++];
		const cleartext_length = cleartext_len_low | (cleartext_len_high << 8);
		const cleartext_data = new Uint8Array(cleartext_length);
		let cleartext_pointer = 0;
		while (remaining_chunks) {
			const size_low = buffer[pointer++];
			const size_high = buffer[pointer++];
			const size = size_low | (size_high << 8);
			// console.log(size, size_high, size_low);
			const ciphertext = new Uint8Array(size);
			
			for (let i = 0; i < size; i++) {
				ciphertext[i] = buffer[pointer++];
			}
			
			// console.log(key.asymmetricKeyDetails, key.asymmetricKeyType, key.type)
			// console.log(Buffer.from(ciphertext), ciphertext.at(-1)!.toString(16))
			const cleartext = Jabber.buffer_to_uint8array(crypto.privateDecrypt(key, ciphertext));
			// console.log('cleartext', cleartext, cleartext_pointer, '/', cleartext_data.length)
			cleartext_data.set(cleartext.subarray(0, Math.min(cleartext.length, cleartext_length - cleartext_pointer)), cleartext_pointer);
			cleartext_pointer += cleartext.length;
			remaining_chunks--;
		}
		return cleartext_data
	}
}

export declare interface BlabberClient {
	on(event: 'open', listener: () => void): this;
	on(event: 'close', listener: () => void): this;
	on(event: 'error', listener: () => void): this;
	on(event: 'packet', listener: (packet: BlabberPacket<PacketType>) => void): this;
	on<T extends keyof PacketNameMap>(event: T, listener: (packet: BlabberPacket<PacketNameMap[T]>) => void): this;
	on<T extends keyof PacketDataMap>(event: `packet$${T}`, listener: (packet: BlabberPacket<T>) => void): this;
	on(event: `from@${number}`, listener: (data: Uint8Array) => void): this;
	on(event: 'data_receive', listener: (data: Uint8Array, from: number) => void): this;
}

/** blabber - the websocket/p2p part of jblabber */
export class BlabberClient extends EventEmitter {
	socket: WebSocket;
	constructor(socket: WebSocket) {
		super();
		this.socket = socket;
		this.socket.addEventListener('open', () => {
			this.emit('open')
		})
		this.socket.addEventListener('close', () => {
			this.emit('close')
		})
		this.socket.addEventListener('error', (e) => {
			this.emit('error', e)
		})
		this.socket.addEventListener('message', async (event) => {
			if (typeof event.data === 'string')
				return;
			
			const bytes = await (event.data as Blob).bytes();
			// if (bytes[0] && bytes.slice(0, 3).every((v, i) => []))
			const packet = BlabberPacket.deserialize(bytes);
			this.emit('packet$'+packet.kind, packet);
			this.emit('packet', packet);
			this.emit(packet.message_class.typeName, packet);
		})
		this.on('DataReceivePacket', (packet: BlabberPacket<PacketType.DataReceivePacket>) => {
			this.emit('data_receive', packet.protobuf_message.data, packet.protobuf_message.from)
			this.emit('from@'+packet.protobuf_message.from, packet.protobuf_message.data)
		})
	}
	wait_for_packet(...types: BlabberPacketType[]): Promise<BlabberPacket<BlabberPacketType>> {
		if (types.length == 0)
			throw new Error('no');
		return new Promise((resolve) => {
			if (types.length == 1)
				return this.once(`packet$${types[0]}`, resolve);
			const listeners: string[] = [];
			const yeag = (packet: BlabberPacket<BlabberPacketType>) => {
				for (const listener of listeners) {
					this.off(listener, yeag)
				}
				resolve(packet);
			}
			for (const type of types) {
				const listener = `packet$${type}`;
				listeners.push(listener);
				this.once(listener, yeag);
			}
		})
	}
	send_packet<T extends BlabberPacketType>(kind: BlabberPacketType, data: PacketDataMap[T]) {
		const packet = new BlabberPacket(kind);
		packet.protobuf_message = data;
		this.socket.send(packet.serialize())
	}
	send_to(data: Uint8Array, to: number) {
		// console.log('send', data, 'to', to)
		this.send_packet(BlabberPacketType.DataSendPacket, {
			data,
			to
		} as blabber_protocol.DataSendPacket)
	}
	announce(data: Uint8Array) {
		// console.log('announce', data)
		this.send_packet(BlabberPacketType.DataAnnouncePacket, {
			data
		} as blabber_protocol.DataAnnouncePacket)
	}
}

export enum JabberPacketType {
	JabberHello = 1,
	JabberHelloResponse = 2,
	JabberIdentify = 3,
	JabberMessagePacket = 4,
	JabberHandshakeReject = 5,
}

export type JabberPacketDataMap = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
	5: jabber_protocol.JabberHandshakeReject,
}

const packet_map: { [K in keyof JabberPacketDataMap]: MessageType<JabberPacketDataMap[K]> } = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
	5: jabber_protocol.JabberHandshakeReject,
}

export class JabberPacket<K extends keyof JabberPacketDataMap> {
	kind: K;
	protobuf_message: JabberPacketDataMap[K];
	message_class: MessageType<JabberPacketDataMap[K]>;
	constructor(kind: K, from?: Uint8Array) {
		if (!(kind in packet_map))
			throw new Error('invalid packet kind');
		this.kind = kind;
		this.message_class = packet_map[kind];
		if (from)
			this.protobuf_message = this.message_class.fromBinary(from)
		else
			this.protobuf_message = this.message_class.create()
	}
	serialize(): Uint8Array {
		const message_class = packet_map[this.kind];
		return new Uint8Array([this.kind, ...message_class.toBinary(this.protobuf_message)])
	}
	static deserialize(packet: Uint8Array): JabberPacket<keyof JabberPacketDataMap> | undefined {
		// if (!packet.slice(0, 3).every((a, i) => PACKET_SIGNATURE[i] === a))
		// 	return;
		const kind = packet[0]
		if (kind === undefined || !(kind in packet_map))
			return;
		return new JabberPacket(kind as keyof JabberPacketDataMap, packet.slice(1));
	}
}

interface Message {
	author: string;
	contents: string;
	date: number
}

interface Contact {
	username: string;
	key_hash: Uint8Array;
	key?: crypto.KeyObject;
	client_id: number;
	handshake_complete: boolean;
	messages: Message[];
}

function compareuint8arrays(arr1: Uint8Array, arr2: Uint8Array) {
	if (arr1.length !== arr2.length)
		return false;
	return arr1.every((a, i) => arr2[i] === a);
}

/** jabber - the e2ee/chat protocol part of jblabber */
export declare interface Jabber {
	// this.emit('packet', packet, from);
	// this.emit('packet@'+from, packet);
	// this.emit('packet$'+packet?.kind, packet, from);
	// this.emit('packet$'+packet?.kind+'@'+from, packet);
	//////////////
	// on(event: 'open', listener: () => void): this;
	// on(event: 'close', listener: () => void): this;
	// on(event: 'error', listener: () => void): this;
	// on<T extends keyof JabberPacketDataMap>(event: T, listener: (packet: JabberPacket<T>) => void): this;
	on(event: 'packet', listener: (packet: JabberPacket<JabberPacketType>, from: number) => void): this;
	on<U extends number>(event: `packet@${U}`, listener: (packet: JabberPacket<JabberPacketType>) => void): this;
	on<T extends keyof JabberPacketDataMap>(event: `packet$${T}`, listener: (packet: JabberPacket<T>, from: number) => void): this;
	on<T extends keyof JabberPacketDataMap,U extends number>(event: `packet$${T}@${U}`, listener: (packet: JabberPacket<T>) => void): this;
	// on(event: 'contact_list_change', listener: () => void): this;
	on(event: 'new_contact', listener: (contact: Contact) => void): this;
	on(event: 'handshake_complete', listener: (contact: Contact) => void): this;
	// on(event: `packet@${number}`, listener: (data: Uint8Array) => void): this;
	// on(event: 'data_receive', listener: (data: Uint8Array, from: number) => void): this;
}
export class Jabber extends EventEmitter {
	static buffer_to_uint8array(data: Buffer) {
		//@ts-ignore:
		return new Uint8Array(data)
	}
	te = new TextEncoder()
	td = new TextDecoder()
	blabber: BlabberClient;
	// handle_poke() {}
	username: string;
	public_key: crypto.KeyObject;
	private_key: crypto.KeyObject;
	contact_list: Map<string, Contact> = new Map();
	username_valid(username: string): boolean {
		if (username.length > 32 || username.length == 0)
			return false;
		if (username.match(/[^a-zA-Z0-9`~!#%^&*()-_.]/))
			return false;
		return true;
	}
	wait_for_packet(...types: JabberPacketType[]) {
		return this.wait_for_packet_from(undefined, ...types)
	}
	/** timeout for wait_for_packet[_from] */
	TIMEOUT = 10 * 1000
	wait_for_packet_from(from: number | undefined, ...types: JabberPacketType[]): Promise<JabberPacket<JabberPacketType>> {
		if (types.length == 0)
			throw new Error('no');
		return new Promise((resolve,reject) => {
			const postfix = from === undefined ? '' : '@'+from
			let timeout: number | undefined;
			setTimeout(() => {
				if (types.length == 1)
					this.off(`packet$${types[0]}`+postfix, end)
				else {
					for (const listener of listeners) {
						this.off(listener, yeag)
					}
				}
				reject('timeout')
			}, this.TIMEOUT)
			function end(packet: JabberPacket<JabberPacketType>) {
				clearTimeout(timeout)
				return resolve(packet)
			}
			if (types.length == 1)
				return this.once(`packet$${types[0]}`+postfix, end);
			const listeners: string[] = [];
			const yeag = (packet: JabberPacket<JabberPacketType>) => {
				for (const listener of listeners) {
					this.off(listener, yeag)
				}
				end(packet);
			}
			for (const type of types) {
				const listener = `packet$${type}`+postfix;
				listeners.push(listener);
				this.once(listener, yeag);
			}
		})
	}
	constructor(url: string = 'ws://localhost:2137', username: string, public_key: crypto.KeyObject, private_key: crypto.KeyObject) {
		super()
		this.username = username;
		this.public_key = public_key;
		this.private_key = private_key;
		this.blabber = new BlabberClient(new WebSocket(url));
		this.blabber.on('open', () => {
			// console.log('open')
			const identify_packet = this.get_identify_packet();
			identify_packet.protobuf_message.new = true;
			this.blabber.announce(identify_packet.serialize())
		})
		this.blabber.on('data_receive', (data, from) => {
			// console.log('a')
			// fs.writeFileSync('packet', data)
			const packet = JabberPacket.deserialize(data);
			// console.log('packet', data, packet?.protobuf_message)
			if (!packet)
				return;
			this.emit('packet', packet, from);
			this.emit('packet@'+from, packet);
			this.emit('packet$'+packet?.kind, packet, from);
			this.emit('packet$'+packet?.kind+'@'+from, packet);
		})
		this.on(`packet$${JabberPacketType.JabberIdentify}`, (packet, from) => {
			const identify_packet = packet as JabberPacket<JabberPacketType.JabberIdentify>;
			// console.log('identity', identify_packet.protobuf_message)
			if (!this.username_valid(identify_packet.protobuf_message.username))
				return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
			const identifier = `${identify_packet.protobuf_message.username}$${Buffer.from(identify_packet.protobuf_message.hash).toString('hex')}`
			if (packet.protobuf_message.new) {
				this.blabber.send_to(this.get_identify_packet().serialize(), from);
			}
			if (this.contact_list.has(identifier)) {
				// console.warn('alredy ther')
				if (this.contact_list.get(identifier)!.client_id === -1) {
					if (!compareuint8arrays(
						this.contact_list.get(identifier)!.key_hash,
						identify_packet.protobuf_message.hash))
						return console.warn('key hash missmatch', this.contact_list.get(identifier)!.key_hash, identify_packet.protobuf_message.hash);
					if (this.contact_list.get(identifier)!.username !==
						identify_packet.protobuf_message.username)
						return console.warn('username missmatch');
					this.contact_list.get(identifier)!.client_id = from;
				}
				return
			}
			this.contact_list.set(identifier, {
				client_id: from,
				handshake_complete: false,
				key_hash: identify_packet.protobuf_message.hash,
				username: identify_packet.protobuf_message.username,
				messages: []
			})
			this.emit('new_contact', this.contact_list.get(identifier))
		});
		this.on(`packet$${JabberPacketType.JabberHello}`, (packet, from) => {
			const hello_packet = packet as JabberPacket<JabberPacketType.JabberHello>;
			const identity_known = this.contact_list.values().find(contact => contact.client_id === from);
			// console.log('hello', hello_packet.protobuf_message)
			let contact: Contact;
			if (!identity_known) {
				if (!hello_packet.protobuf_message.me) {
					console.warn('no me')
					return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
				}
				if (!this.username_valid(hello_packet.protobuf_message.me.username)) {
					console.warn('invlaid username')
					return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
				}
				const identify_packet = hello_packet.protobuf_message.me;
				const identifier = `${identify_packet.username}$${Buffer.from(identify_packet.hash).toString('hex')}`
				if (this.contact_list.has(identifier)) {
					if (this.contact_list.get(identifier)!.client_id === -1) {
						if (!compareuint8arrays(
							this.contact_list.get(identifier)!.key_hash,
							hello_packet.protobuf_message.me.hash))
							return;
						if (this.contact_list.get(identifier)!.username !==
							hello_packet.protobuf_message.me.username)
							return;
						this.contact_list.get(identifier)!.client_id = from;
					}
					if (this.contact_list.get(identifier)!.client_id !== from)
						return;
					throw new Error('invalid state')
				}
				contact = {
					client_id: from,
					handshake_complete: false,
					key_hash: identify_packet.hash,
					username: identify_packet.username,
					messages: []
				};
				this.contact_list.set(identifier, contact)
				this.emit('new_contact', contact);
			} else {
				contact = identity_known;
				if (hello_packet.protobuf_message.me) {
					if (!compareuint8arrays(contact.key_hash, hello_packet.protobuf_message.me.hash)) {
						console.warn('hashes dont match', contact.key_hash, hello_packet.protobuf_message.me.hash)
						return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
					}
					if (contact.username !== hello_packet.protobuf_message.me.username) {
						console.warn('usernames dont match')
						return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
					}
					const hash = crypto.hash('sha512', hello_packet.protobuf_message.publicKey, 'buffer');
					if (!compareuint8arrays(contact.key_hash, Jabber.buffer_to_uint8array(hash))) {
						console.warn('key doesnt match hash')
						return this.blabber.send_to(new JabberPacket(JabberPacketType.JabberHandshakeReject).serialize(), from);
					}
				}
			}
			if (contact.handshake_complete)
				return;
			const public_key = crypto.createPublicKey({
				key: Buffer.from(hello_packet.protobuf_message.publicKey),
				format: 'der',
				type: 'spki',
			}) as crypto.KeyObject;
			if (public_key.asymmetricKeyType !== 'rsa')
				throw new Error('key not rsa')
			// console.log(public_key)
			contact.key = public_key;
			const response = new JabberPacket(JabberPacketType.JabberHelloResponse);
			const cleartext_key = this.public_key.export({format: 'der', type: 'spki'});
			// console.log(cleartext_key)
			const encrypted_key =
				RSAData.encrypt_public(
					public_key,
					Jabber.buffer_to_uint8array(cleartext_key)
				);
			// fs.writeFileSync('encrypted_key', encrypted_key)
			// console.log('encrypted_key', encrypted_key)
			response.protobuf_message.encryptedPublicKey = encrypted_key
			response.protobuf_message.me = this.get_identify_packet().protobuf_message;
			this.blabber.send_to(response.serialize(), from);
			console.log('completed handshake with', contact.username)
			contact.handshake_complete = true;
			this.emit('handshake_complete', contact)
		})
		this.on(`packet$${JabberPacketType.JabberMessagePacket}`, (packet, from) => {
			const contact = this.contact_list.values().find(contact => contact.client_id === from);
			if (!contact) return console.warn('warning', 'message from unknown contact', from);
			if (!contact.handshake_complete) return console.warn('warning', 'handshake incomplete, wont receive message from', contact.username);
			const ciphertext = packet.protobuf_message.encryptedMessage;
			// console.log(ciphertext, crypto.hash('sha256', ciphertext))
			// fs.writeFileSync('whatisithiswhat', ciphertext)
			const cleartext = RSAData.decrypt_private(this.private_key, ciphertext);
			console.log('from', contact.username, ':', this.td.decode(cleartext))
		})
	}
	get_identify_packet(): JabberPacket<JabberPacketType.JabberIdentify> {
		const identify_packet = new JabberPacket(JabberPacketType.JabberIdentify);
		identify_packet.protobuf_message.username = this.username;
		const hash = crypto.hash('sha512', this.public_key.export({format: 'der', type: 'spki'}), 'buffer')
		identify_packet.protobuf_message.hash = Jabber.buffer_to_uint8array(hash);
		// console.log(identify_packet.protobuf_message, identify_packet.serialize())
		return identify_packet;
	}
	async initiate_handshake(contact: Contact) {
		if (contact.handshake_complete)
			return;
		const hello_packet = new JabberPacket(JabberPacketType.JabberHello);
		hello_packet.protobuf_message.me = this.get_identify_packet().protobuf_message;
		hello_packet.protobuf_message.publicKey = Jabber.buffer_to_uint8array(this.public_key.export({format: 'der', type: 'spki'}));
		this.blabber.send_to(hello_packet.serialize(), contact.client_id);
		const response = await this.wait_for_packet_from(contact.client_id, JabberPacketType.JabberHelloResponse || JabberPacketType.JabberHandshakeReject);
		if (response.kind === JabberPacketType.JabberHandshakeReject)
			throw new Error('handshake rejected');
		const good_response = response as JabberPacket<JabberPacketType.JabberHelloResponse>;
		const encrypted_key = good_response.protobuf_message.encryptedPublicKey;
		const raw_key = Buffer.from(RSAData.decrypt_private(this.private_key, encrypted_key));
		contact.key = crypto.createPublicKey({
			format: 'der',
			key: raw_key,
			type: 'spki'
		})
		contact.handshake_complete = true;
		this.emit('handshake_complete', contact)
	}
	send_message_to(contact: Contact, message: Uint8Array | string) {
		if (!contact.handshake_complete)
			throw 'handshake not complete';
		if (typeof message === 'string')
			message = this.te.encode(message);
		const ciphertext = RSAData.encrypt_public(contact.key!, message);
		const packet = new JabberPacket(JabberPacketType.JabberMessagePacket);
		// console.log(ciphertext, crypto.hash('sha256', ciphertext))
		packet.protobuf_message.encryptedMessage = ciphertext;
		this.blabber.send_to(packet.serialize(), contact.client_id);
	}
}

////////////

function attachEELogger(ee:EventEmitter, label?: string) {
	const emit = ee.emit;
	ee.emit = function name(eventName: string | symbol, ...args: any[]) {
		console.log(`[${label??''}] emit`, eventName, ...args);
		return emit.call(this, eventName, ...args);
	}
}

const rl_interface = rl.createInterface(
	process.stdin,
	process.stdout,
	(line: string) => [[],line],
	true
);

if (!fs.existsSync('profile'))
	fs.mkdirSync('profile');
if (!fs.existsSync('profile/contacts'))
	fs.mkdirSync('profile/contacts');
if (!fs.existsSync('profile/contacts.json'))
	fs.writeFileSync('profile/contacts.json', '{}');
if (!fs.existsSync('profile/pub_key') ||
	!fs.existsSync('profile/priv_key')
) {
	console.log('keys not found, creating new key pair')
	// KeyPairExportOptions<"spki", "pkcs8">
	const key_pair = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048
	});
	console.log(crypto.publicEncrypt(key_pair.publicKey, 'test'));
	if (fs.existsSync('profile/pub_key'))
		fs.truncateSync('profile/pub_key');
	fs.writeFileSync('profile/pub_key', key_pair.publicKey.export({format: 'pem', type: 'spki'}));
	if (fs.existsSync('profile/priv_key'))
		fs.truncateSync('profile/priv_key');
	fs.writeFileSync('profile/priv_key', key_pair.privateKey.export({format: 'pem', type: 'pkcs8'}));
}
if (!fs.existsSync('profile/username')) {
	console.log('username not found, enter username')
	const username = await rl_interface.question('?');
	if (!username)
		throw new Error('you have to enter a username, bud');
	if (!Jabber.prototype.username_valid(username))
		throw new Error('invalid username');
	fs.writeFileSync('profile/username', username);
}

const private_key = crypto.createPrivateKey(fs.readFileSync('profile/priv_key').toString());
const public_key = crypto.createPublicKey(fs.readFileSync('profile/pub_key').toString());

if (
	private_key.asymmetricKeyType !== 'rsa' ||
	public_key.asymmetricKeyType !== 'rsa'
) {
	console.warn('ya keys are fucked mate, restart the pogram to generate new wuns');
	fs.rmSync('profile/priv_key')
	fs.rmSync('profile/pub_key')
	process.exit(1)
}

const username = fs.readFileSync('profile/username').toString()

const contact_db: Record<string,string> = JSON.parse(fs.readFileSync('profile/contacts.json').toString())
const jabber = new Jabber('ws://localhost:2137', username, public_key, private_key);

function sync_db() {
	fs.writeFileSync('profile/contacts.json', JSON.stringify(contact_db));
}

jabber.on('new_contact', contact => {
	const this_uuid = uuid.v4();
	const identifier = `${contact.username}$${Buffer.from(contact.key_hash).toString('hex')}`;
	contact_db[identifier] = this_uuid;
	const contact_dir = path.join('profile/contacts', this_uuid)
	if (fs.existsSync(contact_dir))
		fs.rmSync(contact_dir, {recursive:true});
	fs.mkdirSync(contact_dir);
	// fs.writeFileSync(path.join(contact_dir, 'pub_key_hash'), contact.key_hash)
	fs.writeFileSync(path.join(contact_dir, 'messages.json'), '[]');
	sync_db();
})
jabber.on('handshake_complete', contact => {
	const identifier = `${contact.username}$${Buffer.from(contact.key_hash).toString('hex')}`;
	const this_uuid = contact_db[identifier];
	if (!this_uuid)
		throw 'uhhhhhh'
	const contact_dir = path.join('profile/contacts', this_uuid)
	if (!fs.existsSync(contact_dir))
		throw 'invalid state: contact dir does not exist';
	fs.writeFileSync(path.join(contact_dir, 'pub_key'), contact.key!.export({
		format: 'pem',
		type: 'spki'
	}))
})

if (process.argv.includes('-d')) {
	attachEELogger(jabber, 'jabber')
	attachEELogger(jabber.blabber, 'blabber')
}

// const fs_contacts = fs.readdirSync('profile/contacts');

for (const identifier in contact_db) {
	if (!Object.hasOwn(contact_db, identifier)) continue;
	const contact_uuid = contact_db[identifier];
	const [username, key_hash_string] = identifier.split('$')
	// console.log(key_hash_string, identifier)
	const key_hash = Jabber.buffer_to_uint8array(Buffer.from(key_hash_string, 'hex'));
	const key = fs.existsSync(path.join('profile/contacts', contact_uuid, 'pub_key')) ?
		fs.readFileSync(path.join('profile/contacts', contact_uuid, 'pub_key')) :
		null;
	const messages = JSON.parse(fs.readFileSync(path.join('profile/contacts', contact_uuid, 'messages.json')).toString());
	jabber.contact_list.set(identifier, {
		username,
		client_id: -1,
		handshake_complete: key !== null,
		key_hash,
		messages,
		key: key ? crypto.createPublicKey({
			format: 'pem',
			type: 'spki',
			key
		}) : undefined
	});
}

rl_interface.on('SIGINT', () => {
	process.exit(0)
});
rl_interface.on('close', () => process.exit(0));
while (true) {
	const input = await rl_interface.question(': ')
	// console.log(JSON.stringify(input))
	const [command, ...args] = input.split(' ')
	if (input == null || input == '/exit') {
		// ws.close();
		jabber.blabber.socket.close()
		break
	} else if (input == '/list') {
		console.log(jabber.contact_list.entries().map(([id, contact]) => `\
${id}
	username: ${contact.username}
	key hash: ${Buffer.from(contact.key_hash).toString('hex')}
	handshake complete? ${contact.handshake_complete ? 'yes' : 'no'}`).toArray().join('\n'))
		continue
	} else if (command === '/handshake') {
		let contact = jabber.contact_list.get(args[0]);
		if (!contact) {
			const contacts = jabber.contact_list.keys().filter(k => k.includes(args[0])).toArray()
			if (contacts.length === 1) {
				contact = jabber.contact_list.get(contacts[0]);
			}
		}
		if (!contact) {
			console.error('not found')
			continue
		}
		await jabber.initiate_handshake(contact)
		console.log('ok')
		continue;
	} else if (command === '/msg') {
		let contact = jabber.contact_list.get(args[0]);
		if (!contact) {
			const contacts = jabber.contact_list.keys().filter(k => k.includes(args[0])).toArray()
			if (contacts.length === 1) {
				contact = jabber.contact_list.get(contacts[0]);
			}
		}
		if (!contact) {
			console.error('not found')
			continue
		}
		jabber.send_message_to(contact, args.slice(1).join(' '));
		console.log('ok')
		continue;
	}
}
