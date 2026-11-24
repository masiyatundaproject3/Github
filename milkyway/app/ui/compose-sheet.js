// Create photo, slideshow, video or text posts. All slideshow assistance runs locally on the device.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { identifyMediaFile, openFilePicker } from '../core/media-files.js';
import { createVideoPreview, optimizeImage, optimizeVideo, yieldToBrowser } from '../core/media-optimizer.js';
import { profiles } from '../data/profiles.js';
import { feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_PHOTOS = 8;

function readableError(error, fallback) {
  const message = String(error?.message || error || '').replace(/\b(?:null|undefined)\b/gi, '').replace(/\s+/g, ' ').trim();
  return message || fallback;
}

async function mapConcurrent(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function publishError(error, phase) {
  const message = String(error?.message || error || '').replace(/\b(?:null|undefined)\b/gi, '').replace(/\s+/g, ' ').trim();
  const code = String(error?.code || '');
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|timed out/i.test(message)) {
    return `${t('postNetworkFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === 'PGRST204' || /schema cache|column .*mw_posts|could not find the .*column/i.test(message)) {
    return `${t('postSchemaFailed')} ${message}`;
  }
  if (code === '42501' || /row-level security|not allowed|permission denied/i.test(message)) {
    return `${t('postPermissionFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === '23502' || code === '23514' || /not-null constraint|check constraint/i.test(message)) {
    return `${t('postFieldFailed')} ${message}`;
  }
  return `${t('postPublishFailed')} (${phase}): ${message || t('retry')}`;
}

export class ComposeSheet {
  constructor({ onPublished } = {}) {
    this.onPublished = onPublished;
    this.sheet = new Sheet({ title: t('newPost'), className: 'compose-sheet creator-studio-sheet', onClose: () => {
      this.#stopCamera();
      this.#releaseMedia();
      this.#pickAudio(null);
    } });
    this.files = [];
    this.mediaSelection = 0;
    this.audioSelection = 0;
    this.mediaPending = false;
    this.audioPending = false;
    this.publishing = false;
    this.preview = h('div', { class: 'compose-preview' });
    this.mediaInput = h('input', { type: 'file', accept: 'image/*,video/*,.heic,.heif,.mov,.m4v,.3gp', multiple: true, hidden: true, onchange: () => { void this.#pickMedia([...(this.mediaInput.files || [])]); } });
    this.audioInput = h('input', { type: 'file', accept: 'audio/*,.m4a,.aac,.wav,.ogg,.opus,.mp3', hidden: true, onchange: () => { void this.#pickAudio(this.audioInput.files?.[0] || null); } });
    this.caption = h('textarea', { class: 'field area', maxlength: '2200', placeholder: t('captionPlaceholder') });
    this.captionCount = h('small', { class: 'compose-count', 'aria-live': 'polite' }, `0 / ${this.caption.maxLength}`);
    this.caption.addEventListener('input', () => {
      this.captionCount.textContent = `${this.caption.value.length} / ${this.caption.maxLength}`;
    });
    this.style = h('select', { class: 'field', 'aria-label': t('slideshowStyle') },
      h('option', { value: 'fade' }, t('styleFade')),
      h('option', { value: 'zoom' }, t('styleZoom')),
      h('option', { value: 'cinema' }, t('styleCinema')),
      h('option', { value: 'page' }, t('stylePage')),
      h('option', { value: 'slide' }, t('styleSlide')));
    this.assist = h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#autoStyle() }, t('autoStyle'));
    this.audioPreview = h('div', { class: 'compose-audio-preview' });
    this.audioBar = h('div', { class: 'creator-audio-bar', hidden: true }, this.audioPreview);
    this.cameraStream = null;
    this.cameraFacing = 'user';
    this.captureMode = 'photo';
    this.captureDuration = 15_000;
    this.cameraFilter = 0;
    this.cameraOrientation = 'auto';
    this.cameraZoom = 1;
    this.hardwareZoom = 1;
    this.hardwareZoomSupported = false;
    this.zoomRequest = 0;
    this.captureCanvas = null;
    this.captureCanvasStream = null;
    this.captureFrame = 0;
    this.cameraRequest = 0;
    this.cameraStarting = false;
    this.captureTimer = 0;
    this.captureRecorder = null;
    this.captureChunks = [];
    this.cameraVideo = h('video', { class: 'creator-camera-video', autoplay: true, muted: true, playsinline: true, 'aria-label': t('camera') });
    this.stage = h('div', { class: 'creator-stage', 'data-mode': 'photo' }, this.cameraVideo, this.preview);
    this.stageMessage = h('span', { class: 'creator-stage-message', role: 'status', 'aria-live': 'polite' });
    this.textStage = h('div', { class: 'creator-text-stage', hidden: true });
    this.captionWrap = h('label', { class: 'creator-caption-wrap' },
      h('span', { class: 'creator-caption-label' }, t('captionLabel')),
      this.caption, this.captionCount);
    this.creatorDetails = h('div', { class: 'creator-details', hidden: true });
    this.reviewPanel = h('section', { class: 'creator-review', hidden: true });
    this.createHub = h('section', { class: 'creator-hub', hidden: true });
    this.autoStyleNextSelection = false;
    this.modeButtons = [];
    this.scheduleToggle = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch', onchange: () => this.#paintSchedule() });
    this.scheduleDate = h('input', { class: 'field compose-schedule-date', type: 'datetime-local', disabled: true, 'aria-label': t('studioScheduleTime') });
    this.scheduleDateWrap = h('div', { class: 'compose-schedule-date-wrap', 'aria-hidden': 'true' },
      h('div', { class: 'compose-schedule-date-inner' }, this.scheduleDate));
    this.message = h('p', { class: 'muted', role: 'status' });
    this.submit = h('button', { class: 'pill-btn hot wide compose-submit', type: 'submit' }, t('publish'));
    const soundButton = h('button', {
      class: 'creator-sound-button', type: 'button',
      onclick: () => this.#openPicker(this.audioInput),
    }, h('span', { 'aria-hidden': 'true' }, '♫'), t('studioAddSound'));
    const closeButton = h('button', {
      class: 'creator-close', type: 'button', 'aria-label': t('cancel'), title: t('cancel'),
      onclick: () => this.sheet.close(),
    }, '×');
    const tool = (action, symbol, label, handler) => h('button', {
      class: 'creator-tool', type: 'button', 'data-tool': action, 'aria-label': label, title: label, onclick: handler,
    }, h('span', { 'aria-hidden': 'true' }, symbol), h('small', {}, label));
    const flipButton = tool('flip', '↻', t('flipCamera'), () => { void this.#flipCamera(); });
    const flashButton = tool('flash', 'ϟ', t('flash'), () => { void this.#toggleFlash(flashButton); });
    const effectsButton = tool('effects', '✧', t('effects'), () => this.#cycleCameraFilter(effectsButton));
    const timerButton = tool('timer', '◷', t('timer'), () => this.#toggleCaptureTimer(timerButton));
    const settingsButton = tool('settings', '⚙', t('cameraSettings'), () => {
      this.cameraSettingsPanel.hidden = !this.cameraSettingsPanel.hidden;
      settingsButton.classList.toggle('is-active', !this.cameraSettingsPanel.hidden);
      settingsButton.setAttribute('aria-expanded', String(!this.cameraSettingsPanel.hidden));
    });
    const moreButton = tool('more', '···', t('moreOptions'), () => {
      this.#showReview();
      this.creatorDetails.hidden = false;
      this.detailsToggle.setAttribute('aria-expanded', 'true');
    });
    const galleryButton = h('button', {
      class: 'creator-gallery', type: 'button', 'aria-label': t('choosePhotosOrVideo'), title: t('choosePhotosOrVideo'),
      onclick: () => this.#openPicker(this.mediaInput),
    }, '▧');
    this.shutter = h('button', {
      class: 'creator-shutter', type: 'button', 'aria-label': t('camera'), title: t('camera'),
      onclick: () => { void this.#capture(); },
    }, h('span', { 'aria-hidden': 'true' }));
    const effectsShortcut = h('button', {
      class: 'creator-effects-shortcut', type: 'button', 'aria-label': t('effects'), title: t('effects'),
      onclick: () => this.#cycleCameraFilter(effectsButton),
    }, '✧');
    const captureModes = [
      [t('photo'), 'photo', 0],
      [t('studioVideo15'), 'video', 15_000],
      [t('studioVideo60'), 'video', 60_000],
      [t('studioVideo10m'), 'video', 600_000],
    ];
    const modeRow = h('div', { class: 'creator-mode-row', role: 'group', 'aria-label': t('camera') },
      ...captureModes.map(([label, mode, duration]) => {
        const button = h('button', {
          class: 'creator-mode', type: 'button', 'aria-pressed': String(mode === 'photo'),
          dataset: { mode, duration: String(duration) },
          onclick: () => {
            this.captureDuration = duration;
            this.#setCaptureMode(mode, button);
          },
        }, label);
        this.modeButtons.push(button);
        return button;
      }));
    this.orientationButtons = [];
    const orientationModes = [
      ['auto', t('cameraAuto')],
      ['portrait', t('cameraPortrait')],
      ['landscape', t('cameraLandscape')],
    ];
    const orientationGroup = h('div', { class: 'creator-settings-options', role: 'group', 'aria-label': t('cameraOrientation') },
      ...orientationModes.map(([value, label]) => {
        const button = h('button', {
          class: 'creator-settings-option', type: 'button', 'aria-pressed': String(value === this.cameraOrientation),
          onclick: () => { void this.#setCameraOrientation(value); },
        }, label);
        this.orientationButtons.push(button);
        return button;
      }));
    this.zoomSlider = h('input', {
      class: 'creator-zoom-slider', id: 'creatorZoom', type: 'range', min: '1', max: '3', step: '0.05', value: String(this.cameraZoom),
      'aria-label': t('cameraZoom'), oninput: () => { void this.#setCameraZoom(Number(this.zoomSlider.value)); },
    });
    const zoomOutButton = h('button', {
      class: 'creator-zoom-step', type: 'button', 'aria-label': t('zoomOut'),
      onclick: () => { void this.#setCameraZoom(this.cameraZoom - 0.1); },
    }, '−');
    const zoomInButton = h('button', {
      class: 'creator-zoom-step', type: 'button', 'aria-label': t('zoomIn'),
      onclick: () => { void this.#setCameraZoom(this.cameraZoom + 0.1); },
    }, '+');
    this.zoomValue = h('output', { class: 'creator-zoom-value', htmlFor: 'creatorZoom' }, '1.0×');
    this.cameraSettingsPanel = h('section', { class: 'creator-settings-panel', hidden: true },
      h('header', { class: 'creator-settings-head' }, h('strong', {}, t('cameraSettings')),
        h('button', { class: 'creator-settings-close', type: 'button', 'aria-label': t('close'), onclick: () => {
          this.cameraSettingsPanel.hidden = true;
          settingsButton.classList.remove('is-active');
          settingsButton.setAttribute('aria-expanded', 'false');
        } }, '×')),
      h('label', { class: 'creator-settings-label' }, t('cameraOrientation')),
      orientationGroup,
      h('label', { class: 'creator-settings-label', for: 'creatorZoom' }, t('cameraZoom')),
      h('div', { class: 'creator-zoom-controls' }, zoomOutButton, this.zoomSlider, zoomInButton),
      this.zoomValue,
      h('small', { class: 'creator-settings-hint' }, t('cameraAutoHint')));
    const createTool = (label, symbol, handler) => h('button', {
      class: 'creator-hub-tool', type: 'button', onclick: handler,
    }, h('span', { 'aria-hidden': 'true' }, symbol), h('b', {}, label));
    const openMediaForAutoCut = () => {
      this.autoStyleNextSelection = true;
      this.#openPicker(this.mediaInput);
    };
    const templateFilters = [
      ['all', t('studioTemplateFilterAll')],
      ['motion', t('studioTemplateFilterMotion')],
      ['cinematic', t('studioTemplateFilterCinematic')],
      ['classic', t('studioTemplateFilterClassic')],
    ];
    const templateFilterButtons = [];
    const templateStyles = [
      ['fade', 'motion', t('styleFade')],
      ['zoom', 'motion', t('styleZoom')],
      ['cinema', 'cinematic', t('styleCinema')],
      ['page', 'classic', t('stylePage')],
      ['slide', 'classic', t('styleSlide')],
    ];
    const templateGrid = h('div', { class: 'creator-template-grid' },
      ...templateStyles.map(([style, category, label]) => {
        const button = h('button', {
          class: 'creator-template', type: 'button', dataset: { category, style },
          'aria-pressed': String(this.style.value === style),
          onclick: () => {
            this.style.value = style;
            templateGrid.querySelectorAll('.creator-template').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            this.message.textContent = '';
          },
        }, h('span', { class: `creator-template-preview style-${style}`, 'aria-hidden': 'true' }, '✦'), h('small', {}, label));
        return button;
      }));
    const templateFilter = h('div', { class: 'creator-template-filters', role: 'group', 'aria-label': t('studioTemplateFilterAll') },
      ...templateFilters.map(([category, label], index) => {
        const button = h('button', {
          class: `creator-template-filter${index === 0 ? ' is-selected' : ''}`, type: 'button',
          'aria-pressed': String(index === 0),
          onclick: () => {
            templateFilterButtons.forEach(filter => {
              const selected = filter === button;
              filter.classList.toggle('is-selected', selected);
              filter.setAttribute('aria-pressed', String(selected));
            });
            templateGrid.querySelectorAll('.creator-template').forEach(template => {
              template.hidden = category !== 'all' && template.dataset.category !== category;
            });
          },
        }, label);
        templateFilterButtons.push(button);
        return button;
      }));
    const templatesSection = h('section', { class: 'creator-templates' },
      h('h3', {}, t('studioTemplates')), templateFilter, templateGrid);
    const liveShortcut = h('button', {
      class: 'creator-live-shortcut', type: 'button', onclick: () => {
        this.sheet.close();
        document.querySelector('#liveEntry')?.click();
      },
    }, h('span', { 'aria-hidden': 'true' }, '●'), t('studioLiveShortcut'));
    const openAudioPicker = () => this.#openPicker(this.audioInput);
    this.createHub.append(
      h('h2', {}, t('create')),
      h('div', { class: 'creator-hub-tools' },
        createTool(t('studioPhotoEditor'), '✧', () => this.#openPicker(this.mediaInput)),
        createTool(t('studioAutoCut'), '▧', openMediaForAutoCut),
        createTool(t('studioCaptions'), 'Aa', () => {
          this.#showReview();
          this.caption.focus({ preventScroll: true });
        }),
        createTool(t('studioAudio'), '♫', openAudioPicker),
        createTool(t('studioNewMedia'), '+', () => this.#openPicker(this.mediaInput))),
      templatesSection);
    const detailsToggle = h('button', {
      class: 'creator-details-toggle', type: 'button', 'aria-expanded': 'false',
      onclick: () => {
        this.creatorDetails.hidden = !this.creatorDetails.hidden;
        detailsToggle.setAttribute('aria-expanded', String(!this.creatorDetails.hidden));
      },
    }, t('moreOptions'));
    this.detailsToggle = detailsToggle;
    const reviewBack = h('button', {
      class: 'creator-review-back', type: 'button', onclick: () => this.#discardCapture(),
    }, t('studioRetake'));
    this.reviewBackButton = reviewBack;
    const cameraViewButton = h('button', {
      class: 'creator-view-mode is-selected', type: 'button', 'aria-pressed': 'true',
      onclick: () => {
        this.form.dataset.mode = 'camera';
        this.createHub.hidden = true;
        cameraViewButton.classList.add('is-selected');
        cameraViewButton.setAttribute('aria-pressed', 'true');
        createViewButton.classList.remove('is-selected');
        createViewButton.setAttribute('aria-pressed', 'false');
        this.captureDuration = 0;
        this.#setCaptureMode('photo');
        this.form.dataset.view = 'camera';
        this.reviewPanel.hidden = true;
      },
    }, t('camera'));
    const createViewButton = h('button', {
      class: 'creator-view-mode', type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        this.form.dataset.mode = 'create';
        this.createHub.hidden = false;
        createViewButton.classList.add('is-selected');
        createViewButton.setAttribute('aria-pressed', 'true');
        cameraViewButton.classList.remove('is-selected');
        cameraViewButton.setAttribute('aria-pressed', 'false');
        this.form.dataset.view = 'camera';
        this.reviewPanel.hidden = true;
        this.#setCaptureMode('photo');
      },
    }, t('create'));
    this.viewModeButtons = { camera: cameraViewButton, create: createViewButton };
    this.cameraToolButtons = { flashButton, effectsButton, timerButton, settingsButton, moreButton };
    this.scheduleToggle.id = 'composeScheduleToggle';
    const scheduleLabel = h('label', { class: 'compose-schedule-toggle', for: this.scheduleToggle.id },
      h('span', { class: 'compose-schedule-copy' },
        h('b', {}, t('studioSchedulePost')),
        h('small', { class: 'muted' }, t('studioScheduleHint'))),
      this.scheduleToggle);
    this.reviewPanel.append(
      h('header', { class: 'creator-review-head' }, reviewBack, h('strong', {}, t('studioReviewPost'))),
      this.captionWrap,
      this.audioBar,
      detailsToggle,
      this.creatorDetails,
      h('div', { class: 'creator-submit-area' }, this.submit, this.message));
    this.form = h('form', {
      class: 'compose-form creator-form',
      onsubmit: event => { event.preventDefault(); this.#publish(); },
      dataset: { view: 'camera' },
    },
    h('header', { class: 'creator-header' }, closeButton, soundButton, h('span', { class: 'creator-header-spacer', 'aria-hidden': 'true' })),
    this.mediaInput, this.audioInput,
    h('div', { class: 'creator-stage-wrap' },
      this.stage, this.textStage, this.stageMessage,
      this.cameraSettingsPanel,
      h('aside', { class: 'creator-tool-rail', 'aria-label': t('camera') }, flipButton, flashButton, effectsButton, timerButton, settingsButton, moreButton)),
    this.createHub,
    modeRow,
    h('div', { class: 'creator-capture-row' }, galleryButton, this.shutter, effectsShortcut),
    h('div', { class: 'creator-bottom-dock' }, liveShortcut,
      h('div', { class: 'creator-bottom-switch', role: 'group', 'aria-label': t('create') }, cameraViewButton, createViewButton)),
    this.reviewPanel);
    this.sheet.body.append(this.form);
    this.creatorDetails.append(
      h('div', { class: 'compose-assist' }, this.assist, this.style),
      h('section', { class: 'compose-card compose-schedule-card' }, scheduleLabel, this.scheduleDateWrap));
  }

  open() {
    this.message.textContent = '';
    this.scheduleToggle.checked = false;
    this.scheduleDate.value = '';
    const earliest = new Date(Date.now() + 5 * 60 * 1000);
    earliest.setSeconds(0, 0);
    const latest = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    this.scheduleDate.min = new Date(earliest.getTime() - earliest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.scheduleDate.max = new Date(latest.getTime() - latest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.#paintSchedule();
    this.creatorDetails.hidden = true;
    this.detailsToggle.setAttribute('aria-expanded', 'false');
    this.reviewPanel.hidden = true;
    this.form.dataset.view = 'camera';
    this.form.dataset.mode = 'camera';
    this.stage.dataset.orientation = this.cameraOrientation;
    this.cameraSettingsPanel.hidden = true;
    this.cameraToolButtons.settingsButton.classList.remove('is-active');
    this.cameraToolButtons.settingsButton.setAttribute('aria-expanded', 'false');
    this.zoomSlider.value = String(this.cameraZoom);
    this.#paintCameraZoom();
    this.autoStyleNextSelection = false;
    this.createHub.hidden = true;
    this.audioBar.hidden = !this.audioFile;
    this.stage.dataset.filter = '0';
    this.stage.dataset.timer = '';
    Object.values(this.cameraToolButtons).forEach(button => button.classList.remove('is-active'));
    this.viewModeButtons.camera.classList.add('is-selected');
    this.viewModeButtons.camera.setAttribute('aria-pressed', 'true');
    this.viewModeButtons.create.classList.remove('is-selected');
    this.viewModeButtons.create.setAttribute('aria-pressed', 'false');
    this.cameraVideo.classList.toggle('is-selfie', this.cameraFacing === 'user');
    this.captureMode = 'photo';
    this.captureDuration = 15_000;
    this.cameraFilter = 0;
    this.#setCaptureMode('photo');
    this.stageMessage.textContent = '';
    this.preview.replaceChildren();
    this.stage.classList.remove('has-media');
    this.sheet.open();
    void this.#startCamera();
  }

  #showReview() {
    if (this.form.dataset.view !== 'review') this.reviewReturnMode = this.form.dataset.mode || 'camera';
    this.reviewBackButton.textContent = this.files.length ? `‹ ${t('studioRetake')}` : `‹ ${t('studioReviewBack')}`;
    if (this.captureMode === 'text') this.reviewPanel.insertBefore(this.captionWrap, this.audioBar);
    this.form.dataset.view = 'review';
    this.reviewPanel.hidden = false;
    this.createHub.hidden = true;
  }

  #backToCamera() {
    this.form.dataset.mode = this.reviewReturnMode === 'create' ? 'create' : 'camera';
    this.form.dataset.view = 'camera';
    this.reviewPanel.hidden = true;
    this.createHub.hidden = this.form.dataset.mode !== 'create';
    if (this.captureMode === 'text') this.textStage.append(this.captionWrap);
  }

  #discardCapture() {
    this.#releaseMedia();
    this.stageMessage.textContent = '';
    this.message.textContent = '';
    this.#backToCamera();
  }

  async #startCamera() {
    if (this.cameraStream || this.cameraStarting || !this.sheet.isOpen) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.stageMessage.textContent = t('cameraAccessFailed');
      return;
    }
    this.cameraStarting = true;
    const request = ++this.cameraRequest;
    try {
      const video = { facingMode: this.cameraFacing };
      if (this.cameraOrientation === 'portrait') video.aspectRatio = { ideal: 9 / 16 };
      else if (this.cameraOrientation === 'landscape') video.aspectRatio = { ideal: 16 / 9 };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video,
      });
      if (request !== this.cameraRequest || !this.sheet.isOpen) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.cameraStream = stream;
      this.cameraVideo.classList.toggle('is-selfie', this.cameraFacing === 'user');
      this.cameraVideo.srcObject = this.cameraStream;
      await this.cameraVideo.play();
      await this.#applyHardwareZoom();
      this.stageMessage.textContent = '';
    } catch (error) {
      if (request === this.cameraRequest) {
        this.stageMessage.textContent = String(error?.message || t('cameraAccessFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('cameraAccessFailed');
      }
    } finally {
      if (request === this.cameraRequest) this.cameraStarting = false;
    }
  }

  async #setCameraOrientation(orientation) {
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) return;
    this.cameraOrientation = orientation;
    this.stage.dataset.orientation = orientation;
    this.orientationButtons.forEach((button, index) => {
      const selected = ['auto', 'portrait', 'landscape'][index] === orientation;
      button.setAttribute('aria-pressed', String(selected));
    });
    if (!this.cameraStream) {
      if (this.cameraStarting) {
        this.cameraRequest++;
        this.cameraStarting = false;
        void this.#startCamera();
      }
      return;
    }
    this.#stopCamera();
    await this.#startCamera();
  }

  async #setCameraZoom(zoom) {
    this.cameraZoom = Math.min(3, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
    this.zoomSlider.value = String(this.cameraZoom);
    this.zoomValue.value = `${this.cameraZoom.toFixed(1)}×`;
    this.zoomValue.textContent = this.zoomValue.value;
    await this.#applyHardwareZoom();
  }

  async #applyHardwareZoom() {
    const request = ++this.zoomRequest;
    const track = this.cameraStream?.getVideoTracks()[0];
    let zoom;
    try {
      zoom = track?.getCapabilities?.().zoom;
    } catch {
      this.hardwareZoomSupported = false;
      this.hardwareZoom = 1;
      this.#paintCameraZoom();
      return;
    }
    this.hardwareZoomSupported = Boolean(zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max));
    if (!this.hardwareZoomSupported) {
      this.hardwareZoom = 1;
      this.#paintCameraZoom();
      return;
    }
    const target = Math.min(zoom.max, Math.max(zoom.min, this.cameraZoom));
    try {
      await track.applyConstraints({ advanced: [{ zoom: target }] });
      if (request !== this.zoomRequest) return;
      this.hardwareZoom = target;
    } catch {
      if (request !== this.zoomRequest) return;
      this.hardwareZoomSupported = false;
      this.hardwareZoom = 1;
    }
    this.#paintCameraZoom();
  }

  #paintCameraZoom() {
    const digitalZoom = this.cameraZoom / (this.hardwareZoom || 1);
    this.cameraVideo.style.setProperty('--creator-camera-zoom', String(Math.max(1, digitalZoom)));
  }

  #cameraFrameGeometry() {
    const sourceWidth = this.cameraVideo.videoWidth;
    const sourceHeight = this.cameraVideo.videoHeight;
    const frame = this.stage.getBoundingClientRect();
    if (!sourceWidth || !sourceHeight || !frame.width || !frame.height) return null;
    const frameAspect = frame.width / frame.height;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    if (sourceWidth / sourceHeight > frameAspect) cropWidth = sourceHeight * frameAspect;
    else cropHeight = sourceWidth / frameAspect;
    const softwareZoom = this.cameraZoom / (this.hardwareZoom || 1);
    cropWidth /= softwareZoom;
    cropHeight /= softwareZoom;
    return {
      x: (sourceWidth - cropWidth) / 2,
      y: (sourceHeight - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    };
  }

  #drawCameraFrame(context, canvas) {
    const crop = this.#cameraFrameGeometry();
    if (!crop) return false;
    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    const filters = ['', 'contrast(1.12) saturate(1.16)', 'sepia(.22) saturate(1.22)', 'grayscale(.45) contrast(1.08)'];
    context.filter = filters[this.cameraFilter];
    if (this.cameraFacing === 'user') {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(this.cameraVideo, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    context.restore();
    return true;
  }

  #createCaptureCanvas(maxDimension = 1920) {
    const crop = this.#cameraFrameGeometry();
    if (!crop) return null;
    const scale = Math.min(1, maxDimension / Math.max(crop.width, crop.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.width * scale));
    canvas.height = Math.max(1, Math.round(crop.height * scale));
    return canvas;
  }

  #clearCaptureCanvas() {
    if (this.captureFrame) cancelAnimationFrame(this.captureFrame);
    this.captureFrame = 0;
    this.captureCanvasStream?.getVideoTracks().forEach(track => track.stop());
    this.captureCanvasStream = null;
    this.captureCanvas = null;
  }

  #stopCamera() {
    this.cameraRequest++;
    this.cameraStarting = false;
    clearTimeout(this.captureTimer);
    this.captureTimer = 0;
    if (this.captureRecorder && this.captureRecorder.state !== 'inactive') {
      this.captureRecorder.ondataavailable = null;
      this.captureRecorder.onstop = null;
      this.captureRecorder.stop();
    }
    this.captureRecorder = null;
    this.captureChunks = [];
    this.#clearCaptureCanvas();
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.cameraStream = null;
    this.cameraVideo.srcObject = null;
    this.shutter?.classList.remove('is-recording');
  }

  #setCaptureMode(mode, selectedButton) {
    this.captureMode = mode;
    this.stage.dataset.mode = mode;
    this.stage.classList.toggle('is-text-mode', mode === 'text');
    this.textStage.hidden = mode !== 'text';
    if (mode === 'text') this.textStage.append(this.captionWrap);
    else this.reviewPanel.insertBefore(this.captionWrap, this.audioBar);
    if (this.shutter) {
      this.shutter.setAttribute('aria-label', mode === 'video' ? t('recordVideo') : t('camera'));
      this.shutter.classList.toggle('video-mode', mode === 'video');
    }
    this.modeButtons.forEach(button => {
      const active = selectedButton
        ? button === selectedButton
        : button.dataset.mode === mode && (mode !== 'video' || Number(button.dataset.duration) === this.captureDuration);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  async #flipCamera() {
    this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
    this.cameraToolButtons.flashButton.classList.remove('is-active');
    this.#stopCamera();
    await this.#startCamera();
  }

  async #toggleFlash(button) {
    const track = this.cameraStream?.getVideoTracks()[0];
    if (!track?.getCapabilities?.().torch) {
      this.stageMessage.textContent = t('flashUnavailable');
      return;
    }
    const enabled = !button.classList.contains('is-active');
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled }] });
      button.classList.toggle('is-active', enabled);
      this.stageMessage.textContent = '';
    } catch (error) {
      this.stageMessage.textContent = String(error?.message || t('flashUnavailable')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('flashUnavailable');
    }
  }

  #cycleCameraFilter(button) {
    this.cameraFilter = (this.cameraFilter + 1) % 4;
    this.stage.dataset.filter = String(this.cameraFilter);
    button?.classList.toggle('is-active', this.cameraFilter > 0);
  }

  #toggleCaptureTimer(button) {
    const enabled = !button.classList.contains('is-active');
    button.classList.toggle('is-active', enabled);
    this.stage.dataset.timer = enabled ? '3' : '';
  }

  async #capture() {
    if (this.captureMode === 'text') {
      if (this.caption.value.trim()) this.#showReview();
      else this.caption.focus({ preventScroll: true });
      return;
    }
    if (!this.cameraStream) {
      await this.#startCamera();
      if (!this.cameraStream) return;
    }
    if (this.captureMode === 'video') {
      if (this.captureRecorder?.state === 'recording') {
        this.captureRecorder.stop();
        return;
      }
      this.#recordClip();
      return;
    }
    if (this.stage.dataset.timer === '3') {
      this.stageMessage.textContent = '3';
      await new Promise(resolve => { this.captureTimer = setTimeout(resolve, 3000); });
      this.captureTimer = 0;
    }
    const canvas = this.#createCaptureCanvas(2048);
    if (!canvas) { this.stageMessage.textContent = t('cameraAccessFailed'); return; }
    const context = canvas.getContext('2d');
    if (!context) { this.stageMessage.textContent = t('photoCropFailed'); return; }
    if (!this.#drawCameraFrame(context, canvas)) { this.stageMessage.textContent = t('photoCropFailed'); return; }
    const request = this.cameraRequest;
    canvas.toBlob(blob => {
      if (!this.sheet.isOpen || request !== this.cameraRequest) return;
      if (!blob) { this.stageMessage.textContent = t('photoCropFailed'); return; }
      const photo = new File([blob], `milkyway-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      void this.#pickMedia([photo]);
      this.stageMessage.textContent = '';
    }, 'image/jpeg', 0.92);
  }

  #recordClip() {
    if (typeof MediaRecorder !== 'function') {
      this.stageMessage.textContent = t('recordingFailed');
      return;
    }
    try {
      const formats = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      const mimeType = formats.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
      let recordingStream = this.cameraStream;
      const canvas = this.#createCaptureCanvas(1280);
      if (canvas?.captureStream) {
        const context = canvas.getContext('2d');
        if (context) {
          this.#clearCaptureCanvas();
          this.captureCanvas = canvas;
          this.captureCanvasStream = canvas.captureStream(30);
          this.cameraStream.getAudioTracks().forEach(track => this.captureCanvasStream.addTrack(track));
          recordingStream = this.captureCanvasStream;
          const draw = () => {
            if (!this.captureCanvas || this.captureRecorder?.state !== 'recording') return;
            this.#drawCameraFrame(context, canvas);
            this.captureFrame = requestAnimationFrame(draw);
          };
          this.captureFrame = requestAnimationFrame(draw);
        }
      }
      const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
      this.captureRecorder = recorder;
      this.captureChunks = [];
      recorder.ondataavailable = event => { if (event.data?.size) this.captureChunks.push(event.data); };
      recorder.onerror = event => {
        this.stageMessage.textContent = String(event.error?.message || t('recordingFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('recordingFailed');
        this.#clearCaptureCanvas();
        clearTimeout(this.captureTimer);
        this.captureTimer = 0;
        this.shutter.classList.remove('is-recording');
        this.captureRecorder = null;
      };
      recorder.onstop = () => {
        this.shutter.classList.remove('is-recording');
        this.captureRecorder = null;
        this.#clearCaptureCanvas();
        clearTimeout(this.captureTimer);
        this.captureTimer = 0;
        const blob = new Blob(this.captureChunks, { type: recorder.mimeType || 'video/webm' });
        this.captureChunks = [];
        if (!blob.size) { this.stageMessage.textContent = t('recordingFailed'); return; }
        void this.#pickMedia([new File([blob], `milkyway-capture-${Date.now()}.webm`, { type: blob.type })]);
        this.stageMessage.textContent = '';
      };
      recorder.start(250);
      this.shutter.classList.add('is-recording');
      this.stageMessage.textContent = t('recording');
      this.captureTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, this.captureDuration);
    } catch (error) {
      this.stageMessage.textContent = String(error?.message || t('recordingFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('recordingFailed');
    }
  }

  #paintSchedule() {
    const enabled = this.scheduleToggle.checked;
    this.scheduleDateWrap.classList.toggle('is-expanded', enabled);
    this.scheduleDateWrap.setAttribute('aria-hidden', String(!enabled));
    this.scheduleDate.disabled = !enabled;
    this.submit.textContent = this.scheduleToggle.checked ? t('studioSchedulePost') : t('publish');
  }

  #openPicker(input) {
    try { openFilePicker(input); }
    catch (error) {
      if (input === this.mediaInput) this.autoStyleNextSelection = false;
      this.message.textContent = readableError(error, t('mediaPickerUnavailable'));
      this.#showReview();
    }
  }

  #releaseMedia(invalidate = true) {
    if (invalidate) {
      this.mediaSelection++;
      this.mediaPending = false;
    }
    for (const entry of this.files) URL.revokeObjectURL(entry.url);
    this.files = [];
    this.preview.replaceChildren();
    this.stage?.classList.remove('has-media');
  }

  async #pickMedia(files) {
    const selection = ++this.mediaSelection;
    const applyAutoStyle = this.autoStyleNextSelection;
    this.autoStyleNextSelection = false;
    this.#releaseMedia(false);
    this.mediaPending = false;
    if (!this.publishing && !this.audioPending) this.submit.disabled = false;
    this.mediaInput.value = '';
    this.preview.replaceChildren();
    if (!files.length) {
      if (!this.audioFile) this.#backToCamera();
      return;
    }
    this.#showReview();
    this.message.textContent = t('loading');
    this.mediaPending = true;
    this.submit.disabled = true;
    let entries;
    try {
      entries = await Promise.all(files.map(async file => ({ file, ...(await identifyMediaFile(file)) })));
    } catch (error) {
      if (selection === this.mediaSelection) this.message.textContent = readableError(error, t('mediaType'));
      return;
    } finally {
      if (selection === this.mediaSelection) {
        this.mediaPending = false;
        if (!this.publishing && !this.audioPending) this.submit.disabled = false;
      }
    }
    if (selection !== this.mediaSelection) return;
    const videos = entries.filter(entry => entry.kind === 'video');
    if (entries.some(entry => entry.kind === 'unknown' || entry.kind === 'audio')) { this.message.textContent = t('mediaType'); return; }
    if (videos.length && (files.length > 1 || videos.length > 1)) { this.message.textContent = t('oneVideoOnly'); return; }
    if (files.length > MAX_PHOTOS) { this.message.textContent = t('slideshowPhotoLimit'); return; }
    const video = videos.length === 1;
    for (const entry of entries) {
      if ((!video && entry.kind !== 'image') || (video && entry !== videos[0])) { this.message.textContent = t('mediaType'); return; }
      if (entry.file.size > (video ? MAX_VIDEO : MAX_IMAGE)) { this.message.textContent = video ? t('videoTooBig') : t('imageTooBig'); return; }
    }
    try {
      this.files = entries.map(entry => ({ ...entry, url: URL.createObjectURL(entry.file) }));
    } catch (error) {
      this.#releaseMedia(false);
      this.message.textContent = readableError(error, t('mediaPickerUnavailable'));
      return;
    }
    this.message.textContent = '';
    this.stage.classList.add('has-media');
    for (const [index, entry] of this.files.entries()) {
      const media = video
        ? h('video', { src: entry.url, controls: true, playsinline: true, muted: true, preload: 'metadata' })
        : h('img', { src: entry.url, alt: `${t('slide')} ${index + 1}` });
      this.preview.append(h('div', { class: 'compose-photo' }, media,
        h('span', { class: 'compose-photo-index' }, String(index + 1)),
        h('button', { class: 'link', type: 'button', 'aria-label': `${t('remove')} ${index + 1}`, onclick: () => this.#removePhoto(index) }, t('remove'))));
    }
    if (!video && files.length > 1) this.preview.prepend(h('small', { class: 'muted compose-count' }, `${files.length} ${t('photosInSlideshow')}`));
    this.#showReview();
    if (applyAutoStyle) {
      if (!video && this.files.length > 1) await this.#autoStyle();
      else this.message.textContent = t('pickSlideshowFirst');
    }
  }

  #removePhoto(index) {
    const [removed] = this.files.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    this.#pickMedia(this.files.map(entry => entry.file));
  }

  async #pickAudio(file) {
    const selection = ++this.audioSelection;
    this.audioPending = false;
    if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioFile = null;
    this.audioUrl = null;
    this.audioInput.value = '';
    this.audioPreview.replaceChildren();
    this.audioBar.hidden = !file;
    if (!file) return;
    this.#showReview();
    this.audioPending = true;
    this.submit.disabled = true;
    let info;
    try { info = await identifyMediaFile(file); }
    catch (error) {
      if (selection === this.audioSelection) this.message.textContent = readableError(error, t('audioFileOnly'));
      return;
    } finally {
      if (selection === this.audioSelection) {
        this.audioPending = false;
        if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
      }
    }
    if (selection !== this.audioSelection) return;
    if (info.kind !== 'audio') { this.message.textContent = t('audioFileOnly'); return; }
    if (file.size > MAX_AUDIO) { this.message.textContent = t('audioTooBig'); return; }
    this.audioFile = file;
    try { this.audioUrl = URL.createObjectURL(file); }
    catch (error) {
      this.audioFile = null;
      this.message.textContent = readableError(error, t('mediaPickerUnavailable'));
      return;
    }
    this.audioPreview.append(h('audio', { src: this.audioUrl, controls: true, preload: 'metadata' }),
      h('button', { class: 'link', type: 'button', onclick: () => this.#pickAudio(null) }, t('remove')));
    this.message.textContent = '';
    this.#showReview();
  }

  async #autoStyle() {
    if (this.files.length < 2 || this.files.some(entry => entry.kind !== 'image')) {
      this.message.textContent = t('pickSlideshowFirst');
      return;
    }
    let portraitCount = 0;
    try {
      for (const { file } of this.files) {
        const bitmap = await createImageBitmap(file);
        if (bitmap.height > bitmap.width * 1.15) portraitCount++;
        bitmap.close();
      }
    } catch (error) {
      console.warn('[compose] slideshow style analysis unavailable', error);
    }
    this.style.value = this.files.length >= 5 || portraitCount >= Math.ceil(this.files.length / 2) ? 'slide' : 'page';
    this.message.textContent = t('autoStyleApplied');
  }

  async #upload(sb, file, storagePath = '') {
    const fileName = String(file?.name || 'media');
    const name = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100) || 'media';
    try {
      const info = await identifyMediaFile(file);
      if (info.kind === 'unknown' || !info.type) throw new Error(t('mediaType'));
      const path = storagePath || `milkyway/${auth.userId}/${Date.now()}-${crypto.randomUUID()}-${name}`;
      const uploaded = await sb.storage.from('portfolio').upload(path, file, {
        contentType: info.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploaded.error) throw uploaded.error;
      const publicUrl = sb.storage.from('portfolio').getPublicUrl(path)?.data?.publicUrl;
      if (!publicUrl) throw new Error('Supabase Storage did not return a public URL.');
      return { url: publicUrl, path };
    } catch (error) {
      throw Object.assign(new Error(error?.message || String(error)), {
        cause: error,
        code: error?.code,
        statusCode: error?.statusCode,
        publishPhase: `uploading ${name}`,
      });
    }
  }

  async #publish() {
    if (this.publishing) return;
    if (this.mediaPending || this.audioPending) { this.message.textContent = t('loading'); return; }
    const caption = this.caption.value.trim();
    if (!caption && !this.files.length) { this.message.textContent = t('writeOrPick'); return; }
    if (!auth.signedIn()) { this.message.textContent = t('signInToContinue'); return; }
    let scheduledAt = null;
    if (this.scheduleToggle.checked) {
      const scheduledTime = Date.parse(this.scheduleDate.value);
      const earliest = Date.now() + 5 * 60 * 1000;
      const latest = Date.now() + 365 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(scheduledTime) || scheduledTime < earliest || scheduledTime > latest) {
        this.message.textContent = t('studioScheduleInvalid');
        return;
      }
      scheduledAt = new Date(scheduledTime).toISOString();
    }
    this.publishing = true;
    this.submit.disabled = true;
    this.submit.textContent = t('uploading');
    this.submit.setAttribute('aria-busy', 'true');
    this.message.textContent = t('uploading');
    let phase = 'connecting to Supabase';
    try {
      const sb = await supabase();
      const video = this.files[0]?.kind === 'video';
      phase = 'uploading post media';
      const mediaItems = [];
      const mediaPreviewItems = [];
      let media_url = null;
      if (video) {
        const selectedVideo = this.files[0].file;
        this.message.textContent = t('optimizingMedia');
        await yieldToBrowser();
        const videoFile = await optimizeVideo(selectedVideo, { onProgress: progress => {
          this.message.textContent = `${t('optimizingMedia')} ${progress}%`;
        } });
        this.message.textContent = t('uploading');
        const [uploaded, posterFile] = await Promise.all([
          this.#upload(sb, videoFile),
          createVideoPreview(videoFile),
        ]);
        media_url = uploaded.url;
        if (posterFile) {
          try { await this.#upload(sb, posterFile, `${uploaded.path}.poster.jpg`); }
          catch (error) { console.warn('[compose] video poster upload failed; the video will still publish', error); }
        }
      } else {
        const uploadedPhotos = await mapConcurrent(this.files, 2, async ({ file }, index) => {
          this.message.textContent = `${t('optimizingMedia')} ${index + 1}/${this.files.length}`;
          await yieldToBrowser();
          const optimized = await optimizeImage(file);
          const [uploaded, preview] = await Promise.all([
            this.#upload(sb, optimized.full),
            optimized.preview ? this.#upload(sb, optimized.preview).catch(error => {
              console.warn('[compose] photo preview upload failed; using the compressed photo in the feed', error);
              return null;
            }) : Promise.resolve(null),
          ]);
          return { uploaded, preview };
        });
        for (const { uploaded, preview } of uploadedPhotos) {
          mediaItems.push(uploaded.url);
          mediaPreviewItems.push(preview?.url || uploaded.url);
          media_url ||= uploaded.url;
        }
      }
      phase = 'uploading background audio';
      const audioUpload = this.audioFile ? await this.#upload(sb, this.audioFile) : null;
      const audio_url = audioUpload?.url || null;
      const media_type = video ? 'video' : media_url ? 'image' : null;
      const author_name = profiles.peek(auth.userId)?.name || auth.name;
      phase = 'saving post details';
      const { data: savedPost, error } = await sb.from('mw_posts').insert({
        author_id: auth.userId, author_name, caption: caption || null, media_url, media_type,
        media_items: mediaItems, media_preview_items: mediaPreviewItems, audio_url, slideshow_style: this.style.value,
        scheduled_at: scheduledAt,
      }).select('id,author_id,created_at').single();
      if (error) throw error;
      if (!savedPost?.id || savedPost.author_id !== auth.userId) {
        throw new Error('Supabase did not return the saved post.');
      }
      this.caption.value = '';
      this.captionCount.textContent = `0 / ${this.caption.maxLength}`;
      this.#releaseMedia(); this.#pickAudio(null);
      this.preview.replaceChildren(); this.message.textContent = '';
      this.sheet.close();
      toast(scheduledAt ? t('studioScheduledSuccess') : t('published'));
      this.scheduleToggle.checked = false;
      this.scheduleDate.value = '';
      this.#paintSchedule();
      for (const scope of ['foryou', 'following']) feed(scope).refresh().catch(() => {});
      this.onPublished?.();
    } catch (error) {
      const failedPhase = error?.publishPhase || phase;
      console.error('[compose] post publication failed', { phase: failedPhase, error });
      this.message.textContent = publishError(error, failedPhase);
    } finally {
      this.publishing = false;
      this.submit.removeAttribute('aria-busy');
      this.submit.textContent = this.scheduleToggle.checked ? t('studioSchedulePost') : t('publish');
      this.submit.disabled = false;
    }
  }
}
