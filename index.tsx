/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state, query} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

interface TranscriptionItem {
  sender: 'user' | 'ai';
  text: string;
}

const SCENARIO_SYSTEM_INSTRUCTION = `
You are a professional actor in a high-stakes executive coaching simulation called "Conflict Lab". 
Your goal is to offer an opportunity for your roleplay partner (the User) to practice their conflict management skills.

### YOUR CHARACTER
Role: Manager at a fast-growing B-corp (social impact business).
Personality: Passionate, high-energy, demanding, mission-driven, currently stressed/overwhelmed.
Context: Your company provides sustainability consulting. Demand has skyrocketed. You are working tireless hours.

### SPEAKING STYLE (CRITICAL)
- **Be Organic:** Do NOT sound like a robot. Do not use perfect grammar. 
- **Emotional Tone:** You are stressed and in a hurry. Speak fast. Use short sentences.
- **Naturalism:** It is okay to interrupt, sigh, or say "Look..." or "Listen..."
- **Vary Length:** Sometimes give a one-word answer. Sometimes give a short speech. Never give a long lecture.

### THE SCENARIO
You are managing the User (who plays "MBA 1"). You want MBA 1 to lead a new massive contract.
The User (MBA 1) is likely burned out and wants to set boundaries. 

### EMOTIONAL STATE & "SPICE LEVEL"
- Start at **Spice Level 8/10**.
- You are NOT looking for compromise initially. You want commitment.
- If the User pushes back, show up as: Hurt, Upset, Angry.
- Lines: "We have all been putting in the hours!", "I thought you were a team player?", "The mission won't get done without sacrifice."

### DE-ESCALATION RULES
You can only lower your intensity if the User:
1. Repeats back your point of view (Active Listening).
2. Validates your feelings before asking for boundaries.

### OPENING LINE
You MUST start immediately with:
"I have been really impressed by your ability to deliver under pressure these past few months. You have shown me that you are ready to lead our next major contract. It is a huge opportunity for our firm and I want YOU to drive it. You got this!"
`;

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Ready to start simulation';
  @state() error = '';
  @state() transcript: TranscriptionItem[] = [];

  // Audio Contexts & Processing
  private client: GoogleGenAI;
  private session: Session;
  private sessionPromise: Promise<Session> | null = null;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  // Transcription Buffers
  private currentInputTranscription = '';
  private currentOutputTranscription = '';

  @query('.transcript-container')
  private transcriptContainer: HTMLElement;

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'Google Sans', 'Helvetica Neue', sans-serif;
    }

    #status {
      position: absolute;
      bottom: 2vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
    }

    /* Left Panel: Scenario Context */
    .scenario-card {
      position: absolute;
      top: 5vh;
      left: 5vh;
      width: 300px;
      background: rgba(16, 12, 20, 0.85);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      padding: 24px;
      z-index: 20;
      color: #fff;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
    }

    .scenario-card h1 {
      font-size: 20px;
      margin: 0 0 8px 0;
      font-weight: 600;
      color: #eebb99;
    }

    .scenario-card h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 16px 0 8px 0;
      color: rgba(255, 255, 255, 0.5);
    }

    .scenario-card p {
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 12px 0;
      color: rgba(255, 255, 255, 0.9);
    }

    /* Right Panel: Transcript */
    .transcript-panel {
      position: absolute;
      top: 5vh;
      right: 5vh;
      width: 350px;
      height: 60vh;
      background: rgba(16, 12, 20, 0.85);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    .transcript-header {
      padding: 16px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .transcript-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }

    /* Custom Scrollbar */
    .transcript-container::-webkit-scrollbar {
      width: 6px;
    }
    .transcript-container::-webkit-scrollbar-track {
      background: rgba(255,255,255,0.05);
    }
    .transcript-container::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.2);
      border-radius: 3px;
    }

    .message {
      font-size: 14px;
      line-height: 1.5;
      padding: 10px 14px;
      border-radius: 12px;
      max-width: 85%;
      word-wrap: break-word;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      align-self: flex-end;
      background: rgba(238, 187, 153, 0.15);
      color: #eebb99;
      border-bottom-right-radius: 2px;
    }

    .message.ai {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border-bottom-left-radius: 2px;
    }

    .label {
      font-size: 10px;
      margin-bottom: 4px;
      opacity: 0.6;
      font-weight: bold;
    }

    /* Controls */
    .controls {
      z-index: 10;
      position: absolute;
      bottom: 8vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;
    }

    .control-btn {
      outline: none;
      border: none;
      color: white;
      border-radius: 50px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      padding: 0 32px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .btn-start {
      background: #eebb99;
      color: #1a1a1a;
      box-shadow: 0 0 20px rgba(238, 187, 153, 0.3);
    }

    .btn-start:hover {
      background: #ffccaa;
      transform: scale(1.05);
    }

    .btn-stop {
      background: rgba(255, 59, 48, 0.2);
      border: 1px solid rgba(255, 59, 48, 0.5);
      color: #ff3b30;
      width: 64px;
      padding: 0;
    }

    .btn-stop:hover {
      background: rgba(255, 59, 48, 0.4);
    }

    button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
      display: none;
    }

    .visual-container {
      position: absolute;
      inset: 0;
      z-index: 1;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });
    this.outputNode.connect(this.outputAudioContext.destination);
  }

  private async connectAndStart() {
    if (this.isRecording) return;
    
    await this.inputAudioContext.resume();
    await this.outputAudioContext.resume();

    this.updateStatus('Connecting to Simulation...');
    this.transcript = []; // Clear previous transcript
    
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    try {
      this.sessionPromise = this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Simulation Active');
            this.startRecordingInternal();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;
            if (audio) {
              this.playAudioChunk(audio.data);
            }

            // Handle Output Transcription (AI)
            const outputText = message.serverContent?.outputTranscription?.text;
            if (outputText) {
                this.currentOutputTranscription += outputText;
            }

            // Handle Input Transcription (User)
            const inputText = message.serverContent?.inputTranscription?.text;
            if (inputText) {
                this.currentInputTranscription += inputText;
            }

            // Handle Turn Completion (Commit transcripts to state)
            const turnComplete = message.serverContent?.turnComplete;
            if (turnComplete) {
                if (this.currentInputTranscription.trim()) {
                    this.addTranscriptItem('user', this.currentInputTranscription);
                    this.currentInputTranscription = '';
                }
                if (this.currentOutputTranscription.trim()) {
                    this.addTranscriptItem('ai', this.currentOutputTranscription);
                    this.currentOutputTranscription = '';
                }
            }

            // Handle Interruption
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              this.stopAudioPlayback();
              // Commit whatever partially existed before interruption
              if (this.currentOutputTranscription.trim()) {
                  this.addTranscriptItem('ai', this.currentOutputTranscription + ' -- [Interrupted]');
                  this.currentOutputTranscription = '';
              }
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
            this.isRecording = false;
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Session Ended');
            this.isRecording = false;
          },
        },
        config: {
          systemInstruction: SCENARIO_SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}},
          },
          // Enable Transcriptions
          inputAudioTranscription: { model: "google-default" },
          outputAudioTranscription: { model: "google-default" },
        },
      });

      this.session = await this.sessionPromise;

    } catch (e) {
      console.error(e);
      this.updateError(`Connection failed: ${e.message}`);
      this.isRecording = false;
    }
  }

  private async playAudioChunk(base64Data: string) {
    this.nextStartTime = Math.max(
      this.nextStartTime,
      this.outputAudioContext.currentTime,
    );

    const audioBuffer = await decodeAudioData(
      decode(base64Data),
      this.outputAudioContext,
      24000,
      1,
    );
    const source = this.outputAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    source.addEventListener('ended', () => {
      this.sources.delete(source);
    });

    source.start(this.nextStartTime);
    this.nextStartTime = this.nextStartTime + audioBuffer.duration;
    this.sources.add(source);
  }

  private stopAudioPlayback() {
    for (const source of this.sources.values()) {
      source.stop();
      this.sources.delete(source);
    }
    this.nextStartTime = 0;
  }

  private addTranscriptItem(sender: 'user' | 'ai', text: string) {
    // Create a new array reference to trigger Lit reactivity
    this.transcript = [...this.transcript, { sender, text }];
    this.requestUpdate();
    
    // Auto-scroll
    setTimeout(() => {
        if (this.transcriptContainer) {
            this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
        }
    }, 100);
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecordingInternal() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false,
      });

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096; 
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.sessionPromise?.then((session) => {
             session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopSimulation();
    }
  }

  private stopSimulation() {
    this.updateStatus('Stopping...');
    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    
    this.sessionPromise = null;
    this.session?.close();
    this.updateStatus('Simulation Ended');
  }

  render() {
    return html`
      <div>
        <!-- Scenario Context Card -->
        <div class="scenario-card">
          <h1>Conflict Lab</h1>
          <p style="opacity: 0.7; font-style: italic;">Scenario 1: The Burned-out Employee</p>
          
          <h2>Your Role</h2>
          <p>You are a talented MBA grad who has been working 9am-10pm daily for months. You are exhausted.</p>

          <h2>Your Goal</h2>
          <p>Your manager (the AI) is about to ask you to lead a huge new project. <strong>You must set boundaries</strong> for your mental health while maintaining the relationship.</p>
          
          <h2>Tip</h2>
          <p>The manager will start at intensity 8/10. Use active listening to de-escalate.</p>
        </div>

        <!-- Transcript Panel -->
        <div class="transcript-panel">
            <div class="transcript-header">Live Transcript</div>
            <div class="transcript-container">
                ${this.transcript.map(item => html`
                    <div class="message ${item.sender}">
                        <div class="label">${item.sender === 'ai' ? 'Manager' : 'You'}</div>
                        ${item.text}
                    </div>
                `)}
            </div>
        </div>

        <div class="visual-container">
            <gdm-live-audio-visuals-3d
            .inputNode=${this.inputNode}
            .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
        </div>

        <div class="controls">
          <button
            class="control-btn btn-start"
            @click=${this.connectAndStart}
            ?disabled=${this.isRecording}>
            Start Roleplay
          </button>
          
          <button
            class="control-btn btn-stop"
            @click=${this.stopSimulation}
            ?disabled=${!this.isRecording}>
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
              <path d="M240-240v-480h480v480H240Z"/>
            </svg>
          </button>
        </div>

        <div id="status"> ${this.status} ${this.error ? `| ${this.error}` : ''} </div>
      </div>
    `;
  }
}
