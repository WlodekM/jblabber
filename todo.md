# features
 - [x] message signing
 - [x] ACK
 - [x] online/offline detection (detect whether contact is online or offline)
 - [ ] actual message format
	* [ ] attachments
	* [ ] formatting
 - [ ] groupchats (somehow)

# improvements
## protocol
 - [ ] optional x25519 layer
	* [ ] second handshake for negotiating features which can be done after the initial handshake
## client
 - [ ] second node-gtk client (in-progress)
## codebase
 - [ ] clean up
    * [ ] de-clutter
    * [ ] split up big functions
    * [ ] document more stuff
        + [ ] make seperate, up-to-date, protocol docs
        + [ ] document functions

# fixes
 - [x] fix reconnect bugginess
 - [ ] fix messaging an offline person crashing the client

