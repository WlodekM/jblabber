import crypto from 'node:crypto';
import {
	BlabberPacket,
	type PacketDataMap,
	PacketType as BlabberPacketType,
	type PacketNameMap
} from './blabber.ts';
import { EventEmitter } from 'node:events';
// import * as blabber_protocol from './blabber_protocol.ts';
import * as jabber_protocol from './jabber_protocol.ts';
import * as blabber_protocol from './blabber_protocol.ts';
import type { MessageType } from "@protobuf-ts/runtime";
import { Buffer } from 'node:buffer';

const te = new TextEncoder()
const RSA_PACKET_SIGNATURE = te.encode('JBRrsa');

/**
 * RSAData - wrapper for RSA-encrypted data for jabber
 * format:
 * enum type {
 * 	public = 0,
 * 	private = 1
 * };
 * struct chunk {
 * 	uint16_t length, // length of the ciphertext
 * 	char[] ciphertext // the ciphertext
 * }
 * 'JBRrsa' // magic numbers for RSAData
 * enum type data_type // type of the key the data was encrypted with
 * char chunks // number of chunks in the data
 * uint16_t buff_length // the length of the cleartext
 * struct chunk chunks[] // the chunks
 */
export class RSAData {
	static encrypt(key: crypto.KeyObject, buffer: Uint8Array): Uint8Array {
		if (!key.asymmetricKeyDetails)
			throw new Error('key not asymmetric');
		if (key.asymmetricKeyDetails.modulusLength === undefined)
			throw new Error('key.asymmetricKeyDetails.modulusLength is undefined');
		const chunk_size = (214);
		const encrypt_func = key.type === 'private' ? crypto.privateEncrypt : crypto.publicEncrypt;

		const data: (Uint8Array | number[] | number)[] = [RSA_PACKET_SIGNATURE];
		data.push(+(key.type === 'private'));
		data.push(0);
		data.push(buffer.length & 0xFF);
		data.push((buffer.length & 0xFF00) >> 8);
		let pointer = 0;
		while (pointer < buffer.length) {
			let slice = buffer.subarray(pointer, pointer + chunk_size);
			(data[2] as number)++;
			pointer += slice.length
			if(slice.length < chunk_size) {
				slice = new Uint8Array([...slice, ...new Array(chunk_size-slice.length).fill(0)])
			}
			const ciphertext = encrypt_func(key, slice);
			const ui8aciphertext = Jabber.buffer_to_uint8array(ciphertext);
			data.push(ui8aciphertext.length & 0xFF)
			data.push((ui8aciphertext.length & 0xFF00) >> 8)
			data.push(ui8aciphertext)
		}
		return new Uint8Array(data.reduce<number[]>((p, c) => [...p, ...(typeof c === 'number' ? [c] : c)], []))
	}
	static decrypt(key: crypto.KeyObject, buffer: Uint8Array): Uint8Array {
		// console.log(buffer)
		if (compareuint8arrays(buffer.subarray(0, RSA_PACKET_SIGNATURE.length-1), RSA_PACKET_SIGNATURE))
			throw 'no rsa packet';
		let pointer = RSA_PACKET_SIGNATURE.length;
		const key_type = buffer[pointer++];
		if (+(key.type === 'private') === key_type)
			throw 'key of same type as data; this cannot continue';
		const decrypt_func = key.type === 'private' ? crypto.privateDecrypt : crypto.publicDecrypt;
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
			const ciphertext = new Uint8Array(size);
			
			for (let i = 0; i < size; i++) {
				ciphertext[i] = buffer[pointer++];
			}
			
			const cleartext = Jabber.buffer_to_uint8array(decrypt_func(key, ciphertext));
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
	on(event: 'packet', listener: (packet: BlabberPacket<BlabberPacketType>) => void): this;
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
		this.on('DataReceivePacket', (packet: BlabberPacket<BlabberPacketType.DataReceivePacket>) => {
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
	JabberACK = 6,
}

export type JabberPacketDataMap = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
	5: jabber_protocol.JabberHandshakeReject,
	6: jabber_protocol.JabberACK
}

const packet_map: { [K in keyof JabberPacketDataMap]: MessageType<JabberPacketDataMap[K]> } = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
	5: jabber_protocol.JabberHandshakeReject,
	6: jabber_protocol.JabberACK
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

export interface Message {
	author: string;
	contents: string;
	date: number
}

export interface Contact {
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
	on(event: 'message_received', listener: (message: Uint8Array, contact: Contact) => void): this;
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
			const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
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
				return;
			if (identify_packet.protobuf_message.username === this.username &&
				compareuint8arrays(
					identify_packet.protobuf_message.hash,
					Jabber.buffer_to_uint8array(crypto.hash('sha512', this.public_key.export({format: 'der', type: 'spki'}), 'buffer'))
				))
				return;
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
				RSAData.encrypt(
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
			const nack_and_log = (...log: unknown[]) => {
				const nack = new JabberPacket(JabberPacketType.JabberACK);
				nack.protobuf_message.signature = packet.protobuf_message.signature;
				nack.protobuf_message.ok = true;
				this.blabber.send_to(nack.serialize(), from);
				console.warn(log)
			}
			if (!contact) return nack_and_log('warning', 'message from unknown contact', from);
			if (!contact.handshake_complete) return nack_and_log('warning', 'handshake incomplete, wont receive message from', contact.username);
			const ciphertext = packet.protobuf_message.encryptedMessage;
			// console.log(ciphertext, crypto.hash('sha256', ciphertext))
			// fs.writeFileSync('whatisithiswhat', ciphertext)
			const cleartext = RSAData.decrypt(this.private_key, ciphertext);
			if (!crypto.verify(null, cleartext, contact.key!, packet.protobuf_message.signature))
				return nack_and_log('message signature invalid');
			const ack = new JabberPacket(JabberPacketType.JabberACK);
			ack.protobuf_message.signature = packet.protobuf_message.signature;
			ack.protobuf_message.ok = true;
			this.blabber.send_to(ack.serialize(), from);
			this.emit('message_received', cleartext, contact);
		})
	}
	get_identify_packet(): JabberPacket<JabberPacketType.JabberIdentify> {
		const identify_packet = new JabberPacket(JabberPacketType.JabberIdentify);

		identify_packet.protobuf_message.username = this.username;
		const hash = crypto.hash('sha512', this.public_key.export({format: 'der', type: 'spki'}), 'buffer')
		identify_packet.protobuf_message.hash = Jabber.buffer_to_uint8array(hash);
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
		const raw_key = Buffer.from(RSAData.decrypt(this.private_key, encrypted_key));
		contact.key = crypto.createPublicKey({
			format: 'der',
			key: raw_key,
			type: 'spki'
		})
		contact.handshake_complete = true;
		this.emit('handshake_complete', contact)
	}
	send_message_to(contact: Contact, message: Uint8Array | string): Promise<boolean> {
		if (!contact.handshake_complete)
			throw 'handshake not complete';
		if (typeof message === 'string')
			message = this.te.encode(message);
		const packet = new JabberPacket(JabberPacketType.JabberMessagePacket);
		
		const ciphertext = RSAData.encrypt(contact.key!, message);
		packet.protobuf_message.encryptedMessage = ciphertext;
		const signature = Jabber.buffer_to_uint8array(crypto.sign(null, message, this.private_key))
		packet.protobuf_message.signature = signature;
		
		this.blabber.send_to(packet.serialize(), contact.client_id);

		return new Promise((resolve) => {
			// deno-lint-ignore prefer-const
			let timeout: ReturnType<typeof setTimeout>;
			const listener = (packet: JabberPacket<JabberPacketType.JabberACK>) => {
				if (!compareuint8arrays(
					packet.protobuf_message.signature,
					signature
				)) return;
				this.off(`packet$${JabberPacketType.JabberACK}@${contact.client_id}`, listener);
				clearTimeout(timeout)
				resolve(packet.protobuf_message.ok);
			}
			timeout = setTimeout(() => {
				this.off(`packet$${JabberPacketType.JabberACK}@${contact.client_id}`, listener);
				resolve(false)
			}, this.TIMEOUT)
			this.on(`packet$${JabberPacketType.JabberACK}@${contact.client_id}`, listener)
		})
	}
}
