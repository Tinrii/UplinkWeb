import { playSound, SoundHandler, Sounds } from "$lib/components/utils/SoundHandler"
import { CallDirection } from "$lib/enums"
import { Store } from "$lib/state/Store"
import { create_cancellable_handler, type Cancellable } from "$lib/utils/CancellablePromise"
import { log } from "$lib/utils/Logger"
import { RaygunStoreInstance } from "$lib/wasm/RaygunStore"
import Peer, { DataConnection } from "peerjs"
import { _, t } from "svelte-i18n"
import { get, writable, type Writable } from "svelte/store"
import type { Room } from "trystero"
import { joinRoom } from "trystero"
import { NoiseSuppressorWorklet_Name } from "@timephy/rnnoise-wasm"
import NoiseSuppressorWorklet from "@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url"
import vad from "voice-activity-detection"

const CALL_ACK = "CALL_ACCEPT"

const TIME_TO_WAIT_FOR_ANSWER = 35000
export const TIME_TO_SHOW_END_CALL_FEEDBACK = 3500
export const TIME_TO_SHOW_CONNECTING = 30000

let timeOuts: NodeJS.Timeout[] = []

export const usersDeniedTheCall: Writable<string[]> = writable([])
export const usersAcceptedTheCall: Writable<string[]> = writable([])
export const connectionOpened = writable(false)
export const timeCallStarted: Writable<Date | null> = writable(null)
export const callInProgress: Writable<string | null> = writable(null)
export const makeCallSound = writable<SoundHandler | undefined>(undefined)
export const callScreenVisible = writable(false)
export const usersDidInActiveCall = writable<string[]>([])
export const showCallPopUp = writable(false)

const relaysToTest = [
    "wss://nostr-pub.wellorder.net",
    "wss://brb.io",
    "wss://relay.snort.social",
    "wss://relay.damus.io",
    "wss://nostr.mom",
    "wss://relay.nostr.band",
    "wss://nostr.oxtr.dev",
    "wss://nostr.fmt.wiz.biz",
    "wss://nostr-relay.digitalmob.ro",
    "wss://nostr.openchain.fr",
]
const relaysAvailable: Writable<string[]> = writable(relaysToTest)

export enum VoiceRTCMessageType {
    UpdateUser = "UPDATE_USER",
    None = "NONE",
}

export type RemoteStream = {
    user: VoiceRTCUser
    stream: MediaStream | null
}

type VoiceRTCOptions = {
    audio: {
        enabled: boolean
        deafened: boolean
        volume?: number
    }
    video: {
        enabled: boolean
        selfie: boolean
        screenShareEnabled: boolean
    }

    call: {
        onlyAudioCall: boolean
    }
}

export type VoiceRTCUser = {
    did: string
    username: string
    videoEnabled: boolean
    audioEnabled: boolean
    screenShareEnabled: boolean
    isDeafened: boolean
    volume?: number
}

export function voiceRTCUserToString(user: VoiceRTCUser): string {
    return `User: ${user.username} (ID: ${user.did}), Video: ${user.videoEnabled}, Audio: ${user.audioEnabled}, Deafened: ${user.isDeafened}`
}

type VoiceMessage = {
    type: VoiceRTCMessageType
    channel: string
    userInfo: VoiceRTCUser
}

enum ToggleType {
    Video,
    Mute,
    Deafen,
}

export type CallUpdater = {
    create: (stream: RemoteStream) => void
    update: (did: string, data: { user?: VoiceRTCUser; stream?: MediaStream }) => void
    delete: (user: string) => void
}

export type StreamMetaHandler = {
    remove(): void
}

async function handleStreamMeta(did: string, stream: MediaStream): Promise<StreamMetaHandler> {
    const audioContext = new window.AudioContext()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = AUDIO_WINDOW_SIZE
    analyser.smoothingTimeConstant = 0.1
    let noiseSuppressionNode: AudioWorkletNode
    let voiceStopTimeout: NodeJS.Timeout | null = null
    let speaking = false

    await audioContext.audioWorklet.addModule(NoiseSuppressorWorklet)

    noiseSuppressionNode = new AudioWorkletNode(audioContext, NoiseSuppressorWorklet_Name)
    const mediaStreamSource = audioContext.createMediaStreamSource(stream)
    mediaStreamSource.connect(noiseSuppressionNode).connect(analyser)

    function updateMeta(did: string) {
        let muted = stream.getAudioTracks().some(track => !track.enabled || track.readyState === "ended")
        let user = Store.getUser(did)

        user.update(u => ({
            ...u,
            media: {
                ...u.media,
                is_muted: muted,
                is_playing_audio: speaking,
            },
        }))
    }

    const options = {
        onVoiceStart: () => {
            VoiceRTCInstance.localVideoCurrentSrc!.volume = 1
            if (voiceStopTimeout) {
                clearTimeout(voiceStopTimeout)
                voiceStopTimeout = null
            }
            let user = Store.getUser(did)
            log.debug(`Voice detected from ${get(user).name}.`)
            speaking = true

            updateMeta(did)
        },
        onVoiceStop: () => {
            voiceStopTimeout = setTimeout(() => {
                VoiceRTCInstance.localVideoCurrentSrc!.volume = 0
                let user = Store.getUser(did)
                log.debug(`Voice Stopped from ${get(user).name}.`)
                speaking = false
                updateMeta(did)
            }, 200)
        },
    }

    const voiceDetector = vad(audioContext, stream, options)
    voiceDetector.connect()

    return {
        remove: () => {
            analyser.disconnect()
            if (noiseSuppressionNode) noiseSuppressionNode.disconnect()
            voiceDetector.disconnect()
            voiceDetector.destroy()
        },
    }
}

export class Participant {
    did: string
    remotePeerId: string
    private remoteVoiceUser: VoiceRTCUser = {
        did: "",
        username: "unknown",
        videoEnabled: false,
        audioEnabled: false,
        screenShareEnabled: false,
        isDeafened: false,
    }

    stream?: MediaStream
    streamHandler?: StreamMetaHandler
    remove?: (user: string) => void

    constructor(id: string, peer: string) {
        this.did = id
        this.remotePeerId = peer
        this.remoteVoiceUser = {
            ...this.remoteVoiceUser,
            did: this.did,
            audioEnabled: true,
        }
    }

    updateUserData(userData: VoiceRTCUser) {
        this.remoteVoiceUser = userData
        VoiceRTCInstance.remoteVideoCreator?.update(this.did, { user: userData })
    }

    getUser(): VoiceRTCUser {
        return this.remoteVoiceUser
    }

    async handleRemoteStream(stream: MediaStream) {
        if (this.streamHandler) {
            this.streamHandler.remove()
        }
        this.streamHandler = await handleStreamMeta(this.did, stream)
        this.stream = stream
    }

    close() {
        this.stream?.getTracks().forEach(track => track.stop())
        if (this.streamHandler) {
            this.streamHandler.remove()
        }
        VoiceRTCInstance.remoteVideoCreator.delete(this.did)
    }
}

export class CallRoom {
    room: Room
    participants: { [did: string]: Participant } = {}
    start: Date | null = null
    private messageCh: (message: VoiceMessage, to?: string) => void

    constructor(room: Room) {
        this.room = room
        let [ch, rv] = room.makeAction<VoiceMessage>("messages")
        this.messageCh = ch
        this.notify(VoiceRTCMessageType.UpdateUser)
        rv((msg, _) => {
            VoiceRTCInstance.handleWithDataReceived(msg)
        })
        let [did_ch, did_rv] = room.makeAction<string>("did_sync")
        did_rv((did, peer) => {
            if (!get(usersDidInActiveCall).includes(did)) {
                usersDidInActiveCall.update(u => [...u, did])
            }
            this.participants[did] = new Participant(did, peer)
        })
        room.onPeerJoin(async peer => {
            log.debug(`Peer ${peer} joined the room`)
            did_ch(get(Store.state.user).key, peer)
            this.notify(VoiceRTCMessageType.UpdateUser, peer)
            let stream = await VoiceRTCInstance.getLocalStream()
            log.debug(`Sending local stream ${stream} to ${peer}`)
            room.addStream(stream, peer)
            playSound(Sounds.Joined)
            if (!this.start) {
                this.start = new Date()
            }
        })
        room.onPeerTrack((_, peer, _meta) => {
            log.debug(`Receiving track from ${peer}`)
        })
        room.onPeerLeave(peer => {
            log.debug(`Peer ${peer} left the room`)
            let participant = Object.entries(this.participants).find(p => p[1].remotePeerId === peer)
            if (participant) {
                usersDidInActiveCall.update(u => u.filter(did => did !== participant[0]))
                VoiceRTCInstance.remoteVideoCreator.delete(participant[0])
                delete this.participants[participant[0]]
            }
            playSound(Sounds.Disconnect)
            if (this.empty) {
                VoiceRTCInstance.leaveCall(true)
            }
        })
        room.onPeerStream((stream, peer, _meta) => {
            let participant = Object.entries(this.participants).find(p => p[1].remotePeerId === peer)
            log.debug(`Receiving stream from ${peer} - ${participant?.[1].getUser()}`)
            if (participant) {
                VoiceRTCInstance.remoteVideoCreator.create({ user: participant[1].getUser(), stream: stream })
                participant[1].handleRemoteStream(stream)
            }
        })
    }

    toggleStreams(state: boolean, type: ToggleType) {
        switch (type) {
            case ToggleType.Video: {
                VoiceRTCInstance.localStream?.getVideoTracks().forEach(track => (track.enabled = state))
                break
            }
            case ToggleType.Mute: {
                VoiceRTCInstance.localStream?.getAudioTracks().forEach(track => (track.enabled = !state))
                break
            }
            case ToggleType.Deafen: {
                let participants = Object.values(this.participants)
                participants.forEach(p => p.stream?.getAudioTracks().forEach(track => (track.enabled = !state)))
                VoiceRTCInstance.localStream?.getAudioTracks().forEach(track => (track.enabled = !state))
                break
            }
        }
    }

    updateUserData(user: VoiceRTCUser) {
        let participant = Object.values(this.participants).find(p => p.did === user.did)
        let voideRTCUserAsString = voiceRTCUserToString(user)
        log.debug(`Updating user data ${voideRTCUserAsString} for ${participant}`)
        if (participant) {
            participant.updateUserData(user)
        }
    }

    get send(): (message: VoiceMessage, to?: string) => void {
        return this.messageCh
    }

    notify(type: VoiceRTCMessageType, to?: string) {
        let user = get(Store.state.user)
        let data: VoiceMessage = {
            type: type,
            channel: VoiceRTCInstance.channel!,
            userInfo: {
                did: user.key,
                username: user.name,
                videoEnabled: VoiceRTCInstance.callOptions.video.enabled,
                audioEnabled: VoiceRTCInstance.callOptions.audio.enabled,
                screenShareEnabled: VoiceRTCInstance.isScreenSharing,
                isDeafened: VoiceRTCInstance.callOptions.audio.deafened,
                volume: VoiceRTCInstance.callOptions.audio.volume,
            },
        }
        this.send(data, to)
    }

    get empty(): boolean {
        return Object.keys(this.room.getPeers()).length === 0
    }
}

const AUDIO_WINDOW_SIZE = 512
const VOLUME_THRESHOLD = 0

export const callTimeout = writable(false)

export class VoiceRTC {
    channel?: string
    // Local peer that is used to handle incoming call requests
    localPeer: Peer | null = null
    toCall: string[] | null = null
    localStream: MediaStream | null = null
    localStreamHandler?: StreamMetaHandler
    localVideoCurrentSrc: HTMLVideoElement | null = null
    remoteVideoCreator: CallUpdater

    call: CallRoom | null = null

    callOptions: VoiceRTCOptions

    incomingConnections: DataConnection[] = []
    incomingCallFrom: [string, DataConnection] | null = null
    invitations: Cancellable[] = []

    isScreenSharing: boolean = false
    screenStream: MediaStream | null = null

    constructor(options: VoiceRTCOptions) {
        this.callOptions = { ...options }
        this.setupLocalPeer()
        this.remoteVideoCreator = {
            create: stream => {
                Store.state.activeCallMeta.update(s => {
                    s[stream.user.did] = stream
                    return s
                })
            },
            delete: user => {
                Store.state.activeCallMeta.update(s => {
                    if (s[user]) {
                        s[user].stream?.getTracks().forEach(t => t.stop())
                        s[user].stream = null
                        delete s[user]
                    }
                    return s
                })
            },
            update: (did: string, data: { user?: VoiceRTCUser; stream?: MediaStream }) => {
                Store.state.activeCallMeta.update(s => {
                    if (s[did]) {
                        if (data.user) s[did].user = data.user
                        if (data.stream) s[did].stream = data.stream
                        const videoElement = document.getElementById(`remote-user-video-${did}`) as HTMLVideoElement
                        if (videoElement) {
                            log.debug(`Updating video element for user ${did}`)
                            videoElement.srcObject = s[did].stream
                            videoElement.volume = data.user?.volume ?? 1
                            videoElement.play().catch(error => {
                                log.error("Error playing the video, for user: ", data.user?.did, error)
                            })
                        }
                    }
                    return s
                })
            },
        }
        this.subscribe()
    }

    subscribe() {
        Store.state.devices.muted.subscribe(async value => this.toggleMute(value))
        Store.state.devices.cameraEnabled.subscribe(async value => this.toggleVideo(value))
        Store.state.devices.deafened.subscribe(async value => this.toggleDeafen(value))
    }

    async toggleScreenShare(state: boolean) {
        if (!state) {
            await this.stopScreenShare()
        } else {
            await this.startScreenShare()
        }
    }

    async toggleVideo(state: boolean) {
        this.callOptions.video.enabled = state
        if (!this.isScreenSharing) {
            this.localStream?.getVideoTracks().forEach(track => (track.enabled = state))
            this.call?.toggleStreams(state, ToggleType.Video)
        }

        this.call?.notify(VoiceRTCMessageType.UpdateUser)
    }

    async toggleMute(state: boolean) {
        this.callOptions.audio.enabled = !state
        this.localStream?.getAudioTracks().forEach(track => (track.enabled = !state))

        this.call?.toggleStreams(state, ToggleType.Mute)
        this.call?.notify(VoiceRTCMessageType.UpdateUser)
    }

    async toggleDeafen(state: boolean) {
        // TODO: This isn't perfect because if you mute yourself, and then deafen yourself, un-deafaning will also unmute you which could be unexpected
        this.callOptions.audio.enabled = !state

        this.call?.toggleStreams(state, ToggleType.Deafen)
        this.call?.notify(VoiceRTCMessageType.UpdateUser)
    }

    async setVideoElements(localVideoCurrentSrc: HTMLVideoElement) {
        let current: MediaProvider | null = null
        if (this.localVideoCurrentSrc) {
            this.localVideoCurrentSrc.pause()
            current = this.localVideoCurrentSrc.srcObject
            this.localVideoCurrentSrc.srcObject = null
        }
        this.localVideoCurrentSrc = localVideoCurrentSrc
        if (current != null) {
            this.localVideoCurrentSrc.srcObject = current
            this.localVideoCurrentSrc.play()
        }
        new Promise(resolve => setTimeout(resolve, 500))
    }

    private async setupLocalPeer(reset?: boolean) {
        // TODO(Lucas): Work on that in a next PR
        // this.testGoodRelaysForCall()
        if ((reset && this.localPeer) || this.localPeer?.disconnected || this.localPeer?.destroyed) {
            this.localPeer.destroy()
            this.localPeer = null
        }
        if (this.localPeer === null) {
            let userId = get(Store.state.user).key
            while (userId === "0x0") {
                userId = get(Store.state.user).key
                await new Promise(resolve => setTimeout(resolve, 500))
            }
            const peerId = userId.replace("did:key:", "")
            this.localPeer = new Peer(peerId)

            this.localPeer!.on("open", id => {
                log.debug(`My peer ID is: ${id}`)
            })

            // Handle incoming connections
            this.localPeer!.on("connection", conn => {
                conn.on("open", () => {
                    /// It will appear to user that is receiving the call
                    connectionOpened.set(true)
                    log.info(`Receiving connection on channel: ${conn.metadata.channel} from ${conn.metadata.id}, username: ${conn.metadata.username}`)
                    this.incomingConnections.push(conn)
                    this.incomingCallFrom = [conn.metadata.channel, conn]
                    timeCallStarted.set(new Date(conn.metadata.timeCallStarted))
                    Store.setPendingCall(Store.getCallingChat(this.channel!)!, CallDirection.Inbound)
                })

                conn.on("close", () => {
                    log.info(`Connection closed by ${conn.metadata.username}`)
                    if (this.incomingConnections.length === 1) {
                        connectionOpened.set(false)
                    }
                    Store.state.pendingCall.set(null)
                    this.incomingConnections = this.incomingConnections.filter(c => c !== conn)
                    this.incomingCallFrom = null
                })
            })
            this.localPeer!.on("error", this.handleError.bind(this))
        }
    }

    async startScreenShare() {
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            })

            const screenTrack = this.screenStream?.getVideoTracks()[0]
            const videoTrack = this.localStream?.getVideoTracks()[0]
            this.callOptions.video.screenShareEnabled = true

            if (this.localStream && videoTrack && screenTrack) {
                this.localStream.removeTrack(videoTrack)
                this.localStream.addTrack(screenTrack)

                this.call?.room.replaceTrack(videoTrack, screenTrack, this.localStream)
                this.isScreenSharing = true

                screenTrack.onended = () => this.stopScreenShare()
            }
            if (!get(Store.state.devices.screenShare)) {
                Store.updateScreenShareEnabled(true)
            }
            this.call?.notify(VoiceRTCMessageType.UpdateUser)
        } catch (err) {
            Store.state.devices.screenShare.set(false)
            this.callOptions.video.screenShareEnabled = false
            log.error("Error starting screen share:", err)
        }
    }

    async stopScreenShare() {
        if (this.isScreenSharing && this.screenStream) {
            const screenTrack = this.screenStream.getVideoTracks()[0]
            const videoTrack = await navigator.mediaDevices.getUserMedia({ video: true }).then(mediaStream => mediaStream.getVideoTracks()[0])

            this.localStream?.removeTrack(screenTrack)
            if (videoTrack) {
                this.localStream?.addTrack(videoTrack)

                if (this.localStream) {
                    this.call?.room.replaceTrack(screenTrack, videoTrack, this.localStream)
                }
            }

            this.screenStream.getTracks().forEach(track => track.stop())
            this.screenStream = null
            this.isScreenSharing = false
            this.callOptions.video.screenShareEnabled = false
            if (this.callOptions.video.enabled) {
                Store.updateCameraEnabled(true)
            }
            Store.updateScreenShareEnabled(false)
            this.call?.notify(VoiceRTCMessageType.UpdateUser)
        }
    }

    /**
     * Setup a call to make
     * @param recipients users to call
     * @param chatID the chat to make the call in
     * @param onlyAudioCall
     */
    startToMakeACall(recipients: string[], chatID: string, onlyAudioCall: boolean = false) {
        let own = get(Store.state.user).key
        recipients = recipients.filter(r => r !== own)
        this.callOptions.video.enabled = !onlyAudioCall
        Store.state.devices.cameraEnabled.set(!onlyAudioCall)
        this.callOptions.call.onlyAudioCall = onlyAudioCall
        this.callOptions.audio.enabled = true

        this.channel = chatID
        this.toCall = recipients
    }

    /**
     * Actually making the call
     */
    async makeCall(call: boolean = true) {
        if (!this.toCall && !call) {
            log.error("Calling not setup")
            return
        }
        // If in call leave the current one first
        if (this.call) {
            this.call.room.leave()
            this.call = null
        }
        try {
            await this.setupLocalPeer()
            // Create a new call room
            this.createAndSetRoom()
            if (call) {
                this.inviteToCall(this.toCall!)
                const formattedEndTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
                const text = get(_)("settings.calling.startCallMessage", { values: { value: formattedEndTime } })
                await RaygunStoreInstance.send(this.channel!, text.split("\n"), [])
            }
            const timeoutWhenCallIsNull = setTimeout(() => {
                if (this.call === null || this.call.empty) {
                    log.debug("No one joined the call, leaving")
                    callTimeout.set(true)
                    timeOuts.push(
                        setTimeout(() => {
                            if (get(usersAcceptedTheCall).length === 0) {
                                callTimeout.set(false)
                                this.leaveCall(true)
                            }
                        }, TIME_TO_SHOW_END_CALL_FEEDBACK)
                    )
                }
            }, TIME_TO_WAIT_FOR_ANSWER)
            timeOuts.push(timeoutWhenCallIsNull)
            callInProgress.set(this.channel!)
            Store.setActiveCall(Store.getCallingChat(this.channel!)!, CallDirection.Outbound)
        } catch (error) {
            log.error(`Error making call: ${error}`)
        }
        if (this.localVideoCurrentSrc) {
            this.localVideoCurrentSrc.srcObject = await this.getLocalStream()!
            await this.localVideoCurrentSrc.play()
        }
    }

    // Sends a call invitation to the given dids
    // It will keep trying to send the invitation out until the other end accepts or denies it
    async inviteToCall(dids: string[]) {
        if (this.call == null) {
            log.error("Not in a call")
            return
        }
        await this.setupLocalPeer()
        let peers: [string, string][] = dids.map(did => [did, did.replace("did:key:", "")])
        this.invitations.forEach(c => c.cancel())
        this.invitations = peers.map(([did, peer]) => create_cancellable_handler(() => this.sendAndHandleInviteTo(did, peer)))
    }

    private async sendAndHandleInviteTo(did: string, peer: string) {
        const maxRetries = 5
        let attempts = 0
        let handled = false
        let accepted = false

        let conn: DataConnection | undefined
        let connected = false
        while (!handled && !accepted && attempts < maxRetries) {
            try {
                if (!conn) {
                    let callStartedDate = new Date()
                    log.debug(`Trying to send invitation send out to ${peer} ${conn}`)
                    conn = this.localPeer!.connect(peer, {
                        metadata: {
                            did: get(Store.state.user).key,
                            username: get(Store.state.user).name,
                            channel: this.channel,
                            timeCallStarted: callStartedDate.toISOString(),
                        },
                    })
                    conn.on("open", () => {
                        connected = true
                        timeCallStarted.set(callStartedDate)
                    })
                    conn.once("data", d => {
                        if (d === CALL_ACK) {
                            callTimeout.set(false)
                            usersAcceptedTheCall.set([...get(usersAcceptedTheCall), did])
                            accepted = true
                        }
                    })
                    conn.on("close", () => {
                        conn = undefined
                        if (!accepted) {
                            log.info(`Recipient ${did} didn't accept`)
                            usersDeniedTheCall.set([...get(usersDeniedTheCall), did])
                            // Do something else?
                            handled = true
                        }
                    })
                    conn.on("error", e => {
                        attempts += 1
                        conn = undefined
                        log.debug(`${e}: Attempt ${attempts} failed. Retrying...`)
                        if (attempts >= maxRetries) {
                            log.error("Max retries reached. Connection failed.")
                            handled = true
                        }
                    })
                }
                await new Promise(resolve => timeOuts.push(setTimeout(resolve, 3000)))
                if (connected) {
                    // If connection has been made let it ring for 30 sec.
                    await new Promise(resolve => timeOuts.push(setTimeout(resolve, 30000)))
                    conn.close()
                    break
                } else {
                    conn = undefined
                }
            } catch (error) {
                attempts += 1
                log.debug(`Attempt ${attempts} failed. Retrying...`)
                if (attempts >= maxRetries) {
                    log.error("Max retries reached. Connection failed.")
                    break
                }
            }
        }
        return accepted
    }

    /**
     * Tests the connectivity of relay servers for initiating calls.
     *
     * This method iterates over a list of relay URLs specified in `relaysToTest` and attempts to establish a WebSocket
     * connection with each one. It performs the following actions for each relay:
     *
     * - **On Successful Connection (`socket.onopen`):**
     *   - Adds the relay URL to the `relaysWithSuccessfulConnection` array.
     *   - Sends a "ping" message over the WebSocket connection.
     *
     * - **On Connection Error (`socket.onerror`):**
     *   - Logs a warning message with the relay URL and error details.
     *   - Removes the relay from the `remainingRelays` array.
     *   - Closes the WebSocket connection.
     *   - Updates the `relaysAvailable` store with the updated list of remaining relays.
     *
     * After testing all relays, it logs the list of relays with successful connections for debugging purposes.
     *
     * **Side Effects:**
     * - Updates the `relaysAvailable` store by removing relays that failed to connect.
     * - Logs warnings and debug information to assist with monitoring and troubleshooting.
     *
     * @private
     */
    private testGoodRelaysForCall() {
        let remainingRelays: string[] = get(relaysAvailable)
        let relaysWithSuccessfulConnection: string[] = []
        for (let i = 0; i < relaysToTest.length; i++) {
            let currentRelayUrl = relaysToTest[i]

            const socket = new WebSocket(currentRelayUrl)

            socket.onerror = error => {
                remainingRelays = remainingRelays.filter(relay => relay !== currentRelayUrl)
                socket.close()
                relaysAvailable.set(remainingRelays)
            }

            socket.onopen = () => {
                relaysWithSuccessfulConnection.push(currentRelayUrl)
                socket.send("ping")
            }
        }
        log.debug(`Relays connected: ${relaysWithSuccessfulConnection}`)
    }

    private createAndSetRoom() {
        log.debug(`Creating/Joining room in channel ${this.channel}`)
        log.info("Remaining relay urls to create room: ", get(relaysAvailable))

        Store.updateMuted(true)

        this.call = new CallRoom(
            joinRoom(
                {
                    appId: "uplink",
                    // relayUrls: get(relaysAvailable),
                    relayRedundancy: 3,
                },
                this.channel!
            )
        )
    }

    /**
     * Accept an incoming call with the options
     */
    async acceptCall(audioOnly: boolean = false) {
        if (!this.incomingCallFrom) {
            log.error("No call to accept")
            return
        }
        this.callOptions.audio.enabled = audioOnly
        this.callOptions.video.enabled = !audioOnly
        Store.state.devices.cameraEnabled.set(!audioOnly)
        this.callOptions.call.onlyAudioCall = audioOnly
        // If in a existing call leave it first
        this.call?.room.leave()
        this.call = null
        this.channel = this.incomingCallFrom[0]
        callInProgress.set(this.channel!)
        // Tell the other end you accepted the call
        this.incomingCallFrom[1].send(CALL_ACK)
        this.createAndSetRoom()
        this.incomingConnections.forEach(conn => {
            conn.close()
        })
        this.incomingConnections = []
        this.incomingCallFrom = null
        if (this.localVideoCurrentSrc) {
            this.localVideoCurrentSrc.srcObject = await this.getLocalStream()!
            await this.localVideoCurrentSrc.play()
        }
    }

    async leaveCall(sendEndCallMessage = false) {
        callInProgress.set(null)
        timeCallStarted.set(null)
        showCallPopUp.set(false)
        usersDeniedTheCall.set([])
        callTimeout.set(false)
        connectionOpened.set(false)
        usersAcceptedTheCall.set([])
        timeOuts.forEach(t => clearTimeout(t))
        sendEndCallMessage = sendEndCallMessage && this.channel !== undefined && this.call != null
        if (sendEndCallMessage && this.call?.start) {
            const now = new Date()
            const duration = this.getDuration(now)
            const formattedEndTime = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
            const endText = get(_)("settings.calling.endCallMessage", { values: { formattedEndTime: formattedEndTime, duration: duration } })
            await RaygunStoreInstance.send(this.channel!, endText.split("\n"), [])
        } else if (sendEndCallMessage && this.call?.start === null) {
            const text = get(_)("settings.calling.callMissed")
            await RaygunStoreInstance.send(this.channel!, text.split("\n"), [])
        }

        this.clearResources()

        if (get(Store.state.activeCall)) {
            Store.endCall()
        }
        callScreenVisible.set(false)

        if (get(Store.state.pendingCall)) {
            Store.denyCall()
        }

        log.info("Call ended and resources cleaned up.")
        this.setupLocalPeer(true)
    }

    async getLocalStream(replace = false) {
        if (this.isScreenSharing && this.screenStream) {
            return this.screenStream
        }
        if (!this.localStream || replace) {
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop())
                if (replace && this.call) {
                    this.call.room.removeStream(this.localStream)
                }
            }
            this.localStream = await this.createLocalStream()
            if (this.localStreamHandler) {
                this.localStreamHandler.remove()
            }
            this.localStreamHandler = await handleStreamMeta(get(Store.state.user).key, this.localStream)
            if (this.localVideoCurrentSrc) {
                this.localVideoCurrentSrc.srcObject = this.localStream
                await this.localVideoCurrentSrc.play()
            }

            this.call?.room.addStream(this.localStream)
        }

        return this.localStream
    }

    private async createLocalStream() {
        let localStream
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        })
        localStream.getVideoTracks().forEach(track => {
            track.enabled = this.callOptions.video.enabled
        })
        localStream.getAudioTracks().forEach(track => {
            track.enabled = this.callOptions.audio.enabled
        })

        return localStream
    }

    get isInCall(): boolean {
        return this.call != null
    }

    handleWithDataReceived(dataReceived: VoiceMessage) {
        log.debug(`Data received from ${dataReceived.userInfo.username}: ${dataReceived.type}`)
        switch (dataReceived.type) {
            case VoiceRTCMessageType.UpdateUser:
                this.call?.updateUserData(dataReceived.userInfo)
                break
            case VoiceRTCMessageType.None:
                break
            default:
                log.debug(`Unknown message type: ${dataReceived.type}`)
        }
    }

    private getDuration(endTime: Date): string {
        if (!this.call?.start) return "0:00"

        const durationMs = endTime.getTime() - this.call.start.getTime()
        const totalSeconds = Math.floor(durationMs / 1000)
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60

        if (minutes === 0) {
            const fractionalSeconds = (durationMs / 1000).toFixed(2)
            return `${fractionalSeconds} seconds`
        } else {
            const minutesFormatted = minutes.toString().padStart(2, "0")
            return `${minutesFormatted}min`
        }
    }

    private clearResources() {
        this.channel = undefined
        this.toCall = null
        this.incomingConnections = []
        this.incomingCallFrom = null
        this.invitations.forEach(c => c.cancel())
        this.invitations = []
        this.localPeer?.destroy()
        this.localPeer = null
        if (this.localVideoCurrentSrc) {
            this.localVideoCurrentSrc.pause()
            this.localVideoCurrentSrc.srcObject = null
            this.localVideoCurrentSrc = null
        }
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop())
        }
        this.screenStream = null
        this.isScreenSharing = false
        if (this.localStream) this.localStream.getTracks().forEach(track => track.stop())
        this.localStream = null
        if (this.localStreamHandler) {
            this.localStreamHandler.remove()
        }

        this.call?.room.leave()
        this.call = null
        Store.state.activeCallMeta.set({})
        Store.state.devices.screenShare.set(false)
    }

    handleError(error: Error) {
        log.error(`Error: ${error}`)
    }
}

export const VoiceRTCInstance = new VoiceRTC({
    audio: {
        enabled: get(Store.state.devices.muted),
        deafened: false,
    },
    video: {
        enabled: get(Store.state.devices.cameraEnabled),
        selfie: true,
        screenShareEnabled: false,
    },
    call: {
        onlyAudioCall: false,
    },
})
