// Shared DM input bar, media attachment preview and in-chat audio/video note recording.
import { identifyMediaFile } from '../core/media-files.js';
import { t } from '../core/i18n.js';
import { h, toast } from './dom.js';
import { createVoiceEffects, VOICE_PRESETS } from './voice-effects.js';

const fileInput = () => h('input', {
  class: 'chat-media-picker', type: 'file', accept: 'image/*,video/*,audio/*', tabindex: '-1', 'aria-hidden': 'true',
});

function recordingType(kind) {
  const options = kind === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
    : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}

function mediaFile(blob, kind) {
  const extension = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const name = `${kind === 'audio' ? 'voice-note' : 'video-note'}-${Date.now()}.${extension}`;
  if (typeof File === 'function') return new File([blob], name, { type: blob.type || (kind === 'audio' ? 'audio/webm' : 'video/webm'), lastModified: Date.now() });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

const waveform = (peaks = [], className = '') => h('span', { class: `dm-waveform ${className}`, 'aria-hidden': 'true' },
  ...(peaks.length ? peaks : [0.2, 0.4, 0.7, 0.45, 0.8, 0.3, 0.55, 0.35, 0.65, 0.25, 0.5, 0.3, 0.7, 0.4, 0.55, 0.2])
    .slice(0, 60).map(peak => h('i', { style: `--peak:${Math.max(0.14, Math.min(1, Number(peak) || 0.2))}` })));

export class ChatComposer {
  constructor({ onSendText, onSendMedia, onCaptureError } = {}) {
    this.onSendText = onSendText;
    this.onSendMedia = onSendMedia;
    this.onCaptureError = onCaptureError;
    this.pendingMedia = null;
    this.objectUrl = '';
    this.viewOnce = false;
    this.recording = null;
    this.recordingStarting = false;
    this.captureGeneration = 0;
    this.voicePreset = 'normal';
    this.input = h('textarea', { class: 'field msg-input', rows: '1', maxlength: '4000', placeholder: t('typeMessage'), 'aria-label': t('typeMessage') });
    this.picker = fileInput();
    this.attachment = this.#tool(t('attachMedia'), '＋', () => this.picker.click());
    this.voice = this.#tool(t('recordVoiceNote'), '🎙', () => this.#record('audio'));
    this.voiceEffectButton = this.#tool(t('voiceChanger'), '♫', () => {
      this.voicePresetSelect.hidden = !this.voicePresetSelect.hidden;
      if (!this.voicePresetSelect.hidden) this.voicePresetSelect.focus();
    });
    this.voiceEffectButton.classList.add('chat-voice-changer');
    this.voicePresetSelect = h('select', {
      class: 'chat-voice-preset', hidden: true, 'aria-label': t('voiceChanger'),
      onchange: () => this.#setVoicePreset(this.voicePresetSelect.value),
    }, ...VOICE_PRESETS.map(preset => h('option', { value: preset.id }, t(preset.key))));
    this.video = h('button', {
      class: 'chat-tool chat-video-note', type: 'button', 'aria-pressed': 'false', 'aria-label': t('recordVideoNote'),
      title: t('recordVideoNote'), onclick: () => this.#record('video'),
    }, '◉');
    this.once = h('button', {
      class: 'chat-tool chat-view-once', type: 'button', 'aria-pressed': 'false',
      title: t('viewOnce'), 'aria-label': t('viewOnce'),
      onclick: () => this.#toggleOnce(),
    }, '1×');
    this.send = h('button', { class: 'pill-btn hot msg-send', type: 'submit', 'aria-label': t('send') }, t('send'));
    this.preview = h('div', { class: 'chat-media-preview', hidden: true });
    this.form = h('form', { class: 'msg-form dm-composer', onsubmit: event => { event.preventDefault(); this.#submit(); } },
      this.preview,
      h('div', { class: 'dm-composer-row' }, this.attachment, this.input,
        h('div', { class: 'dm-composer-actions' }, this.once, this.voice, this.voiceEffectButton, this.video, this.voicePresetSelect), this.send),
      this.picker);
    this.picker.addEventListener('change', () => {
      const file = this.picker.files?.[0];
      this.picker.value = '';
      if (file) this.#queue(file, '');
    });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.#submit(); }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
    });
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
      this.voice.disabled = true;
      this.video.disabled = true;
    }
  }

  #tool(label, text, action) {
    return h('button', { class: 'chat-tool', type: 'button', 'aria-label': label, title: label, onclick: action }, text);
  }

  #toggleOnce() {
    this.viewOnce = !this.viewOnce;
    this.once.setAttribute('aria-pressed', String(this.viewOnce));
    this.once.classList.toggle('active', this.viewOnce);
  }

  #setVoicePreset(id) {
    try {
      if (id !== 'normal' && this.recording?.kind === 'audio' && !this.recording.effects) {
        throw new Error(t('voiceEffectsUnsupported'));
      }
      this.recording?.effects?.setPreset(id);
      this.voicePreset = id;
      this.voiceEffectButton.classList.toggle('active', id !== 'normal');
      this.voiceEffectButton.title = `${t('voiceChanger')}: ${t(VOICE_PRESETS.find(preset => preset.id === id)?.key || 'voicePresetNormal')}`;
      this.voicePresetSelect.hidden = true;
    } catch (error) {
      this.voicePresetSelect.value = this.voicePreset;
      toast(error?.message || t('voicePresetUnavailable'));
    }
  }

  async #queue(file, noteType, peaks = []) {
    const info = await identifyMediaFile(file).catch(() => ({ kind: 'unknown', type: '' }));
    if (!['image', 'video', 'audio'].includes(info.kind)) {
      toast(t('mediaType'));
      return;
    }
    if (noteType === 'video_note' && info.kind !== 'video') return;
    this.#clearPreview();
    this.pendingMedia = { file, noteType, kind: info.kind, type: info.type || file.type, peaks };
    const url = URL.createObjectURL(file);
    this.objectUrl = url;
    let preview;
    if (info.kind === 'image') preview = h('img', { src: url, alt: t('attachmentPreview') });
    else if (info.kind === 'video') preview = h('video', { src: url, controls: true, playsinline: true, class: noteType === 'video_note' ? 'video-note-preview' : '' });
    else preview = h('audio', { src: url, controls: true });
    this.preview.replaceChildren(
      h('div', { class: 'chat-media-preview-content' }, preview,
        noteType === 'voice_note' ? waveform(peaks) : null,
        h('span', { class: 'chat-media-name' }, noteType === 'voice_note' ? t('voiceNotePreview') : noteType === 'video_note' ? t('videoNotePreview') : String(file.name || t('attachment')).slice(0, 80))),
      h('button', { class: 'chat-tool', type: 'button', 'aria-label': t('removeAttachment'), onclick: () => this.#clearPreview() }, '×'));
    this.preview.hidden = false;
    this.input.hidden = Boolean(noteType);
  }

  #clearPreview() {
    this.pendingMedia = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.preview.replaceChildren();
    this.preview.hidden = true;
    this.input.hidden = false;
  }

  cancelRecording() {
    this.captureGeneration++;
    this.recordingStarting = false;
    if (!this.recording) return;
    this.recording.cancelled = true;
    if (this.recording.recorder.state !== 'inactive') this.recording.recorder.stop();
  }

  async #submit() {
    if (this.pendingMedia) {
      const media = this.pendingMedia;
      this.send.disabled = true;
      try {
        await this.onSendMedia?.({ ...media, viewOnce: this.viewOnce });
        this.#clearPreview();
        if (this.viewOnce) this.#toggleOnce();
      } catch (error) {
        toast(error?.message || t('messageFailed'));
      } finally { this.send.disabled = false; }
      return;
    }
    const text = this.input.value.trim();
    if (!text) return;
    this.send.disabled = true;
    try {
      await this.onSendText?.(text, this.viewOnce);
      this.input.value = '';
      this.input.style.height = '';
      if (this.viewOnce) this.#toggleOnce();
    } catch (error) { toast(error?.message || t('messageFailed')); }
    finally { this.send.disabled = false; }
  }

  async #record(kind) {
    if (this.recording) {
      if (this.recording.kind === kind && this.recording.recorder.state !== 'inactive') this.recording.recorder.stop();
      return;
    }
    if (this.recordingStarting) return;
    const generation = ++this.captureGeneration;
    this.recordingStarting = true;
    let stream;
    let recordingStream;
    let effects;
    let context;
    let sampleTimer;
    let clock;
    try {
      stream = await navigator.mediaDevices.getUserMedia(kind === 'audio'
        ? { audio: true }
        : { audio: true, video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } } });
      if (generation !== this.captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      recordingStream = stream;
      if (kind === 'audio') {
        try {
          effects = createVoiceEffects(stream, this.voicePreset);
          recordingStream = effects.stream;
        } catch (error) {
          if (this.voicePreset !== 'normal') throw new Error(t('voiceEffectsUnsupported'));
        }
      }
      const mimeType = recordingType(kind);
      const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      const peaks = [];
      let analyser, source;
      if (kind === 'audio' && (window.AudioContext || window.webkitAudioContext)) {
        try {
          context = new (window.AudioContext || window.webkitAudioContext)();
          analyser = context.createAnalyser();
          analyser.fftSize = 256;
          source = context.createMediaStreamSource(recordingStream);
          source.connect(analyser);
          const samples = new Uint8Array(analyser.fftSize);
          sampleTimer = setInterval(() => {
            analyser.getByteTimeDomainData(samples);
            let power = 0;
            for (const sample of samples) { const delta = (sample - 128) / 128; power += delta * delta; }
            peaks.push(Math.max(0.14, Math.min(1, Math.sqrt(power / samples.length) * 3)));
            if (peaks.length > 120) peaks.shift();
            if (this.recording?.kind === kind) this.recording.wave.replaceChildren(...waveform(peaks).childNodes);
          }, 100);
        } catch { context = null; }
      }
      const preview = kind === 'video'
        ? h('video', { class: 'video-note-preview is-recording', autoplay: true, muted: true, playsinline: true })
        : waveform(peaks, 'is-recording');
      if (kind === 'video') preview.srcObject = stream;
      const time = h('span', { class: 'chat-record-time' }, '00:00');
      const stop = this.#tool(t('stopRecording'), '■', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      });
      const cancel = this.#tool(t('cancel'), '×', () => {
        this.recording.cancelled = true;
        if (recorder.state !== 'inactive') recorder.stop();
      });
      const panel = h('div', { class: `chat-recorder ${kind === 'video' ? 'video' : 'audio'}` }, preview, time, stop, cancel);
      this.preview.replaceChildren(panel);
      this.preview.hidden = false;
      this.input.hidden = true;
      const capture = { kind, recorder, wave: preview, effects, cancelled: false };
      this.recording = capture;
      this.recordingStarting = false;
      this.voice.classList.toggle('is-recording', kind === 'audio');
      this.video.classList.toggle('is-recording', kind === 'video');
      this.voice.setAttribute('aria-pressed', String(kind === 'audio'));
      this.video.setAttribute('aria-pressed', String(kind === 'video'));
      this.voice.setAttribute('aria-label', kind === 'audio' ? t('stopRecording') : t('recordVoiceNote'));
      this.video.setAttribute('aria-label', kind === 'video' ? t('stopRecording') : t('recordVideoNote'));
      this.voice.title = kind === 'audio' ? t('stopRecording') : t('recordVoiceNote');
      this.video.title = kind === 'video' ? t('stopRecording') : t('recordVideoNote');
      const started = Date.now();
      clock = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        if (seconds >= (kind === 'audio' ? 180 : 60) && recorder.state !== 'inactive') recorder.stop();
      }, 250);
      recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        capture.failed = true;
        clearInterval(clock); clearInterval(sampleTimer); stream.getTracks().forEach(track => track.stop());
        effects?.close();
        context?.close().catch(() => {});
        if (this.recording === capture) {
          this.recording = null;
          this.#resetRecordingControls();
          this.#clearPreview();
        }
        if (capture.cancelled) return;
        const error = new Error(t('recordingFailed'));
        if (this.onCaptureError) this.onCaptureError(error);
        else toast(error.message);
      }, { once: true });
      recorder.addEventListener('stop', () => {
        clearInterval(clock); clearInterval(sampleTimer);
        stream.getTracks().forEach(track => track.stop());
        effects?.close();
        context?.close().catch(() => {});
        const isCurrent = this.recording === capture;
        if (isCurrent) {
          this.recording = null;
          this.#resetRecordingControls();
        }
        if (capture.cancelled || capture.failed) {
          if (isCurrent) this.#clearPreview();
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || (kind === 'audio' ? 'audio/webm' : 'video/webm') });
        if (!blob.size) { this.#clearPreview(); toast(t('recordingFailed')); return; }
        this.#queue(mediaFile(blob, kind), kind === 'audio' ? 'voice_note' : 'video_note', peaks);
      }, { once: true });
      recorder.start(250);
    } catch (error) {
      this.recordingStarting = false;
      clearInterval(clock);
      clearInterval(sampleTimer);
      stream?.getTracks().forEach(track => track.stop());
      effects?.close();
      context?.close().catch(() => {});
      if (generation !== this.captureGeneration) return;
      this.recording = null;
      this.#resetRecordingControls();
      this.#clearPreview();
      if (this.onCaptureError) this.onCaptureError(error);
      else toast(error?.message || t('recordingFailed'));
    }
  }

  #resetRecordingControls() {
    this.voice.classList.remove('is-recording');
    this.video.classList.remove('is-recording');
    this.voice.setAttribute('aria-pressed', 'false');
    this.video.setAttribute('aria-pressed', 'false');
    this.voice.setAttribute('aria-label', t('recordVoiceNote'));
    this.video.setAttribute('aria-label', t('recordVideoNote'));
    this.voice.title = t('recordVoiceNote');
    this.video.title = t('recordVideoNote');
  }
}

export function mediaMessageContent(row, { onViewOnce, mine = false } = {}) {
  if (row.view_once) {
    return h('div', { class: 'view-once-card' },
      h('span', { class: 'view-once-icon' }, '1×'),
      h('span', {}, mine ? t('viewOnceSent') : t('viewOnceMessage')),
      typeof onViewOnce === 'function' ? h('button', { class: 'pill-btn hot', type: 'button', onclick: onViewOnce }, t('tapToViewOnce')) : null);
  }
  if (!row.media_url || !row.media_type) return h('p', {}, row.body);
  if (row.message_type === 'voice_note' || row.media_type.startsWith('audio/')) {
    return h('div', { class: 'dm-voice-message' },
      waveform(Array.isArray(row.media_metadata?.waveform) ? row.media_metadata.waveform : []),
      h('audio', { controls: true, preload: 'none', src: row.media_url }));
  }
  if (row.message_type === 'video_note') {
    return h('video', { class: 'video-note-playback', controls: true, playsinline: true, preload: 'metadata', src: row.media_url });
  }
  if (row.media_type.startsWith('image/')) return h('img', { class: 'dm-image-message', src: row.media_url, alt: t('attachment'), loading: 'lazy' });
  if (row.media_type.startsWith('video/')) return h('video', { class: 'dm-video-message', controls: true, playsinline: true, preload: 'metadata', src: row.media_url });
  return h('a', { href: row.media_url, target: '_blank', rel: 'noopener noreferrer' }, t('attachment'));
}
