import type { ConcreteSceneTheme, HeroId, MonsterSpec } from './types'

export type TransformSfxKind = 'rise' | 'open' | 'type'

type SfxKey =
  | 'transform-open'
  | 'transform-rise'
  | 'type-change'
  | 'voice-tiga'
  | 'voice-shuwat'
  | 'voice-taro'
  | 'voice-heisei-a'
  | 'voice-heisei-b'
  | 'swing'
  | 'dodge'
  | 'punch-1'
  | 'punch-2'
  | 'heavy-impact'
  | 'clash-impact'
  | 'hero-hurt'
  | 'beam-normal'
  | 'beam-super'
  | 'beam-clash'
  | 'palm-shot'
  | 'disc'
  | 'guard-block'
  | 'deflect'
  | 'roar-gomora'
  | 'roar-baltan'
  | 'roar-kaiju-a'
  | 'roar-kaiju-b'
  | 'explosion-1'
  | 'explosion-2'
  | 'timer-classic'
  | 'timer-heisei'
  | 'rainbow-charge'
  | 'victory'
  | 'shutter'

const SFX_URLS: Record<SfxKey, string> = {
  'transform-open': '/audio/ultraman/sfx/transform-open.mp3',
  'transform-rise': '/audio/ultraman/sfx/transform-rise.mp3',
  'type-change': '/audio/ultraman/sfx/type-change.mp3',
  'voice-tiga': '/audio/ultraman/sfx/voice-tiga.mp3',
  'voice-shuwat': '/audio/ultraman/sfx/voice-shuwat.mp3',
  'voice-taro': '/audio/ultraman/sfx/voice-taro.mp3',
  'voice-heisei-a': '/audio/ultraman/sfx/voice-heisei-a.mp3',
  'voice-heisei-b': '/audio/ultraman/sfx/voice-heisei-b.mp3',
  swing: '/audio/ultraman/sfx/swing.mp3',
  dodge: '/audio/ultraman/sfx/dodge.mp3',
  'punch-1': '/audio/ultraman/sfx/punch-1.mp3',
  'punch-2': '/audio/ultraman/sfx/punch-2.mp3',
  'heavy-impact': '/audio/ultraman/sfx/heavy-impact.mp3',
  'clash-impact': '/audio/ultraman/sfx/clash-impact.mp3',
  'hero-hurt': '/audio/ultraman/sfx/hero-hurt.mp3',
  'beam-normal': '/audio/ultraman/sfx/beam-normal.mp3',
  'beam-super': '/audio/ultraman/sfx/beam-super.mp3',
  'beam-clash': '/audio/ultraman/sfx/beam-clash.mp3',
  'palm-shot': '/audio/ultraman/sfx/palm-shot.mp3',
  disc: '/audio/ultraman/sfx/disc.mp3',
  'guard-block': '/audio/ultraman/sfx/guard-block.mp3',
  deflect: '/audio/ultraman/sfx/deflect.mp3',
  'roar-gomora': '/audio/ultraman/sfx/roar-gomora.mp3',
  'roar-baltan': '/audio/ultraman/sfx/roar-baltan.mp3',
  'roar-kaiju-a': '/audio/ultraman/sfx/roar-kaiju-a.mp3',
  'roar-kaiju-b': '/audio/ultraman/sfx/roar-kaiju-b.mp3',
  'explosion-1': '/audio/ultraman/sfx/explosion-1.mp3',
  'explosion-2': '/audio/ultraman/sfx/explosion-2.mp3',
  'timer-classic': '/audio/ultraman/sfx/timer-classic.mp3',
  'timer-heisei': '/audio/ultraman/sfx/timer-heisei.mp3',
  'rainbow-charge': '/audio/ultraman/sfx/rainbow-charge.mp3',
  victory: '/audio/ultraman/sfx/victory.mp3',
  shutter: '/audio/ultraman/sfx/shutter.mp3',
}

interface PlaySampleOptions {
  volume?: number
  rate?: number
  rateJitter?: number
  pan?: number
  delay?: number
  offset?: number
  duration?: number
}

/**
 * 特摄多轨真实采样 + 动态物理合成混音引擎：
 * - 完整保留 33 条特摄原声采样，并在此基础上叠加材质分层打击共振（金属/甲壳/邪能）、连击音高递增
 * - 次声重低音下扫合成（巨人脚步/落地/重击/爆炸胸腔震感）
 * - 连续可调音高蓄力嗡鸣、完美闪避时空减速音、精准弹反共振钟鸣、克制战场环境底噪
 * - 对外发出自定义 `ultra-bgm-duck` 事件，让背景音乐在大招/爆炸/变身瞬间自动闪避避让
 */
export class UltraAudio {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private buffers = new Map<SfxKey, AudioBuffer>()
  private loading = new Map<SfxKey, Promise<AudioBuffer | null>>()
  private preloaded = false
  private disposed = false

  public muted = false
  private heroId: HeroId = 'tiga'
  private monsterId = 'gomora-mecha'
  private punchCounter = 0
  private lastVoiceAt = -Infinity
  private alarmSource: AudioBufferSourceNode | null = null
  private alarmGain: GainNode | null = null
  private alarmDesired = false

  // 连续蓄力嗡鸣节点
  private chargeOsc: OscillatorNode | null = null
  private chargeGain: GainNode | null = null

  // 战场环境底噪节点
  private ambSource: AudioBufferSourceNode | null = null
  private ambFilter: BiquadFilterNode | null = null
  private ambGain: GainNode | null = null
  private ambTheme: ConcreteSceneTheme | null = null

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return null
      this.ctx = new AudioCtx()
      this.compressor = this.ctx.createDynamicsCompressor()
      this.compressor.threshold.value = -10
      this.compressor.knee.value = 18
      this.compressor.ratio.value = 6
      this.compressor.attack.value = 0.003
      this.compressor.release.value = 0.14
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0.92
      this.compressor.connect(this.masterGain)
      this.masterGain.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
    return this.ctx
  }

  public unlock() {
    this.ensureContext()
    void this.preload()
  }

  public setHero(id: HeroId) {
    this.heroId = id
  }

  public setMonster(id: string) {
    this.monsterId = id
  }

  /** 通知背景音轨在大招/变身/爆炸期间短时压低音量，突出主音效冲击力 */
  private duckBgm(durationSec: number, gain = 0.32) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('ultra-bgm-duck', { detail: { durationSec, gain } }),
    )
  }

  public preload(): Promise<void> {
    if (this.preloaded || this.disposed) return Promise.resolve()
    this.preloaded = true
    const ctx = this.ensureContext()
    if (!ctx) {
      this.preloaded = false
      return Promise.resolve()
    }
    const keys = Object.keys(SFX_URLS) as SfxKey[]
    return Promise.all(keys.map((k) => this.loadSample(k))).then(() => undefined)
  }

  private loadSample(key: SfxKey): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.loading.get(key)
    if (pending) return pending

    const ctx = this.ensureContext()
    if (!ctx) return Promise.resolve(null)

    const url = SFX_URLS[key]
    const task = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`[UltraAudio] 加载音效失败 (${res.status}): ${url}`)
        return res.arrayBuffer()
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((decoded) => {
        if (!this.disposed) this.buffers.set(key, decoded)
        return decoded
      })
      .catch((err) => {
        console.error(`[UltraAudio] 真实音效解码失败: ${key}`, err)
        return null
      })
      .finally(() => {
        this.loading.delete(key)
      })

    this.loading.set(key, task)
    return task
  }

  private playSample(key: SfxKey, opts: PlaySampleOptions = {}) {
    if (this.muted || this.disposed) return
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return

    const trigger = (buffer: AudioBuffer) => {
      if (this.muted || this.disposed || !this.ctx || !this.compressor) return
      const src = this.ctx.createBufferSource()
      src.buffer = buffer

      const baseRate = opts.rate ?? 1
      const jitter = opts.rateJitter ? (Math.random() * 2 - 1) * opts.rateJitter : 0
      src.playbackRate.value = Math.max(0.5, baseRate + jitter)

      const gain = this.ctx.createGain()
      gain.gain.value = opts.volume ?? 0.8

      if (opts.pan !== undefined && typeof this.ctx.createStereoPanner === 'function') {
        const panner = this.ctx.createStereoPanner()
        panner.pan.value = Math.max(-1, Math.min(1, opts.pan))
        src.connect(gain).connect(panner).connect(this.compressor)
      } else {
        src.connect(gain).connect(this.compressor)
      }

      const startAt = this.ctx.currentTime + (opts.delay ?? 0)
      const offset = opts.offset ?? 0
      if (opts.duration !== undefined) {
        src.start(startAt, offset, opts.duration)
      } else {
        src.start(startAt, offset)
      }
    }

    const ready = this.buffers.get(key)
    if (ready) {
      trigger(ready)
      return
    }
    void this.loadSample(key).then((buf) => {
      if (buf) trigger(buf)
    })
  }

  /** 次声重低音物理冲击合成（巨人重踏 / 重击命中 / 爆炸胸口震撼） */
  public playSubBassHit(intensity = 0.7, duration = 0.24) {
    if (this.muted || this.disposed) return
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(98 + intensity * 26, now)
    osc.frequency.exponentialRampToValueAtTime(34, now + duration)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(Math.min(0.52, intensity * 0.42), now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(gain).connect(this.compressor)
    osc.start(now)
    osc.stop(now + duration + 0.02)
  }

  /** 叠加怪兽材质专属打击共振层（金属装甲清鸣 / 甲壳爆裂 / 邪能异响） */
  private playArmorResonance(material: MonsterSpec['armorMaterial'], heavy: boolean, pan = 0) {
    if (this.muted || this.disposed) return
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return
    const now = ctx.currentTime

    if (material === 'metal') {
      // 双失谐高频金属片碰撞锵鸣
      const freqs = heavy ? [1840, 2920, 4180] : [2250, 3410]
      for (const f of freqs) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(f * (0.97 + Math.random() * 0.06), now)
        osc.frequency.exponentialRampToValueAtTime(f * 0.86, now + 0.16)
        gain.gain.setValueAtTime(heavy ? 0.14 : 0.085, now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + (heavy ? 0.2 : 0.12))
        osc.connect(gain).connect(this.compressor)
        osc.start(now)
        osc.stop(now + 0.22)
      }
    } else if (material === 'chitin') {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sawtooth'
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 1150
      filter.Q.value = 3.2
      osc.frequency.setValueAtTime(heavy ? 620 : 880, now)
      osc.frequency.exponentialRampToValueAtTime(210, now + 0.11)
      gain.gain.setValueAtTime(heavy ? 0.18 : 0.11, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
      osc.connect(filter).connect(gain).connect(this.compressor)
      osc.start(now)
      osc.stop(now + 0.14)
    } else if (material === 'eldritch') {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(heavy ? 320 : 460, now)
      osc.frequency.exponentialRampToValueAtTime(118, now + 0.18)
      gain.gain.setValueAtTime(heavy ? 0.18 : 0.1, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19)
      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner()
        panner.pan.value = Math.max(-1, Math.min(1, pan))
        osc.connect(gain).connect(panner).connect(this.compressor)
      } else {
        osc.connect(gain).connect(this.compressor)
      }
      osc.start(now)
      osc.stop(now + 0.2)
    }
  }

  /** 材质与连击张力分层打击音效（替代单调拳击音） */
  public playImpact(
    material: MonsterSpec['armorMaterial'] = 'flesh',
    heavy = false,
    combo = 1,
    pan = 0,
  ) {
    this.punchCounter++
    // 连击音高微升张力（每连击 +1.6%，上限 +20%）
    const comboRate = 1 + Math.min(0.2, Math.max(0, combo - 1) * 0.016)
    if (heavy) {
      this.playSample('heavy-impact', {
        volume: 0.94,
        rate: comboRate * 0.98,
        rateJitter: 0.04,
        pan,
      })
      this.playSample('clash-impact', {
        volume: 0.65,
        delay: 0.02,
        rate: comboRate,
        rateJitter: 0.04,
        pan,
      })
      this.playSubBassHit(0.95, 0.28)
      this.playArmorResonance(material, true, pan)
      this.playHeroVoice('heavy', 0.02, 380)
    } else {
      const key: SfxKey = this.punchCounter % 2 === 0 ? 'punch-2' : 'punch-1'
      this.playSample(key, {
        volume: 0.84,
        rate: comboRate,
        rateJitter: 0.05,
        pan,
      })
      this.playSubBassHit(0.45, 0.14)
      this.playArmorResonance(material, false, pan)
      if (this.punchCounter % 3 === 1) {
        this.playHeroVoice('light', 0.01, 440)
      }
    }
  }

  /** 巨人迈步/跳跃着陆沉重脚踏闷响 */
  public playFootstep(heavy = false) {
    this.playSubBassHit(heavy ? 0.85 : 0.34, heavy ? 0.26 : 0.13)
  }

  /** 完美闪避触发子弹时间的时空下潜滤音 */
  public playBulletTime() {
    if (this.muted || this.disposed) return
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(520, now)
    osc.frequency.exponentialRampToValueAtTime(92, now + 0.34)
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.28, now + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36)
    osc.connect(gain).connect(this.compressor)
    osc.start(now)
    osc.stop(now + 0.38)
    this.playSample('dodge', { volume: 0.72, rate: 0.76 })
  }

  /** 精准弹反高能共振钟鸣 */
  public playParry() {
    this.playSample('deflect', { volume: 0.94, rate: 1.12 })
    this.playSample('guard-block', { volume: 0.72, rate: 1.18, delay: 0.02 })
    this.playSubBassHit(0.75, 0.22)
    this.playArmorResonance('metal', true, 0)
  }

  /** 连续可调蓄力嗡鸣（level ∈ [0, 1]，0 时平滑静音） */
  public setChargeHum(level: number) {
    if (this.muted || this.disposed || level <= 0.04) {
      if (this.chargeGain && this.ctx) {
        this.chargeGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.04)
      }
      return
    }
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return
    if (!this.chargeOsc || !this.chargeGain) {
      this.chargeOsc = ctx.createOscillator()
      this.chargeOsc.type = 'triangle'
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 920
      this.chargeGain = ctx.createGain()
      this.chargeGain.gain.value = 0.0001
      this.chargeOsc.connect(filter).connect(this.chargeGain).connect(this.compressor)
      this.chargeOsc.start()
    }
    const clamped = Math.min(1, Math.max(0, level))
    this.chargeOsc.frequency.setTargetAtTime(140 + clamped * 380, ctx.currentTime, 0.05)
    this.chargeGain.gain.setTargetAtTime(0.03 + clamped * 0.085, ctx.currentTime, 0.05)
  }

  /** 战场空间环境低频底噪（城市火场低风 / 海港轻浪 / 火山熔岩低鸣，音量克制） */
  public setAmbience(theme: ConcreteSceneTheme, active: boolean) {
    if (!active || this.muted || this.disposed) {
      if (this.ambGain && this.ctx) {
        this.ambGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25)
      }
      return
    }
    const ctx = this.ensureContext()
    if (!ctx || !this.compressor) return
    if (!this.ambSource) {
      // 生成 2.5 秒循环粉红噪声缓冲
      const len = Math.floor(ctx.sampleRate * 2.5)
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = buf.getChannelData(0)
      let b0 = 0
      let b1 = 0
      let b2 = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.997 * b0 + w * 0.029
        b1 = 0.985 * b1 + w * 0.032
        b2 = 0.95 * b2 + w * 0.048
        data[i] = (b0 + b1 + b2) * 0.35
      }
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 260
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      src.connect(filter).connect(gain).connect(this.compressor)
      src.start()
      this.ambSource = src
      this.ambFilter = filter
      this.ambGain = gain
    }
    if (this.ambTheme !== theme && this.ambFilter) {
      this.ambTheme = theme
      const freq = theme === 'volcano' ? 165 : theme === 'seaside' ? 380 : theme === 'city' ? 240 : 300
      this.ambFilter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.3)
    }
    if (this.ambGain) {
      const vol = theme === 'volcano' ? 0.14 : theme === 'city' ? 0.11 : 0.08
      this.ambGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.35)
    }
  }

  private playHeroVoice(style: 'light' | 'heavy' | 'signature', delay = 0, minGapMs = 380) {
    const now = performance.now()
    if (now - this.lastVoiceAt < minGapMs) return
    this.lastVoiceAt = now

    let key: SfxKey
    if (style === 'signature') {
      key = this.heroId === 'tiga' ? 'voice-tiga' : 'voice-shuwat'
    } else if (style === 'heavy') {
      key = this.heroId === 'tiga' ? 'voice-tiga' : 'voice-taro'
    } else {
      const pool: SfxKey[] =
        this.heroId === 'tiga'
          ? ['voice-heisei-a', 'voice-heisei-b', 'voice-tiga']
          : ['voice-heisei-a', 'voice-heisei-b', 'voice-shuwat']
      key = pool[this.punchCounter % pool.length]!
    }
    this.playSample(key, {
      volume: style === 'light' ? 0.56 : 0.78,
      rateJitter: 0.04,
      delay,
    })
  }

  public playTransform(kind: TransformSfxKind = 'rise') {
    if (kind === 'open') {
      this.playSample('transform-open', { volume: 0.84 })
      return
    }
    if (kind === 'type') {
      this.playSample('type-change', { volume: 0.88 })
      return
    }
    this.duckBgm(2.2, 0.25)
    this.playSample('transform-rise', { volume: 0.92 })
    this.playSubBassHit(0.9, 0.35)
    this.playHeroVoice('signature', 0.24, 0)
  }

  public playSwing(side: 'left' | 'right', kick: boolean) {
    this.playSample('swing', {
      volume: kick ? 0.68 : 0.52,
      rate: kick ? 0.84 : 1.04,
      rateJitter: 0.06,
      pan: side === 'left' ? -0.55 : 0.55,
    })
    if (kick) {
      this.playHeroVoice('heavy', 0.03, 320)
    }
  }

  public playPunch(hit = true) {
    if (!hit) {
      this.playSample('swing', { volume: 0.45, rate: 1.08, rateJitter: 0.06 })
      return
    }
    this.playImpact('flesh', false, 1, 0)
  }

  public playHeavyImpact() {
    this.playImpact('metal', true, 3, 0)
  }

  public playDeflect() {
    this.playSample('deflect', { volume: 0.85, rateJitter: 0.05 })
  }

  public playDodge() {
    this.playSample('dodge', { volume: 0.64, rateJitter: 0.06 })
  }

  public playBeamClash() {
    this.duckBgm(2.4, 0.34)
    this.playSample('beam-clash', { volume: 0.9 })
  }

  public playDisc() {
    this.playSample('disc', { volume: 0.86, rateJitter: 0.04 })
    this.playHeroVoice('light', 0.02, 260)
  }

  public playBeam(isSuper = false) {
    this.duckBgm(isSuper ? 2.6 : 1.6, isSuper ? 0.24 : 0.36)
    if (isSuper) {
      this.playSample('beam-super', { volume: 0.96 })
      this.playSample('beam-normal', { volume: 0.72, delay: 0.14 })
      this.playSubBassHit(1.0, 0.42)
      this.playHeroVoice('signature', 0.04, 0)
    } else {
      this.playSample('beam-normal', { volume: 0.9 })
      this.playSubBassHit(0.75, 0.28)
      this.playHeroVoice('heavy', 0.02, 200)
    }
  }

  public playGuardBlock() {
    this.playSample('guard-block', { volume: 0.9, rateJitter: 0.04 })
    this.playSubBassHit(0.55, 0.18)
  }

  public playHeroHurt() {
    this.playSample('hero-hurt', { volume: 0.86, rate: 0.9, rateJitter: 0.05 })
    this.playSubBassHit(0.85, 0.24)
  }

  public playRoar(monsterId = this.monsterId) {
    let key: SfxKey = 'roar-kaiju-a'
    if (monsterId === 'gomora-mecha') key = 'roar-gomora'
    else if (monsterId === 'baltan') key = 'roar-baltan'
    else if (monsterId === 'gatanothor') key = 'roar-kaiju-b'
    this.playSample(key, { volume: 0.9, rateJitter: 0.03 })
    this.playSubBassHit(0.7, 0.32)
  }

  public playWarning() {
    this.playSample('timer-heisei', { volume: 0.42, rate: 1.18, duration: 0.34 })
  }

  public playExplosion() {
    this.duckBgm(2.2, 0.22)
    this.playSample('explosion-1', { volume: 0.94 })
    this.playSample('explosion-2', { volume: 0.86, delay: 0.14 })
    this.playSubBassHit(1.0, 0.48)
  }

  public playPalmShot() {
    this.playSample('palm-shot', { volume: 0.74, rateJitter: 0.08 })
  }

  public playGrapplePush() {
    this.playSample('clash-impact', {
      volume: 0.62,
      rate: 1.18,
      rateJitter: 0.08,
      duration: 0.36,
    })
    this.playSubBassHit(0.5, 0.15)
  }

  public playRainbowCharge() {
    this.duckBgm(1.8, 0.32)
    this.playSample('rainbow-charge', { volume: 0.82 })
  }

  public playShutter() {
    this.playSample('shutter', { volume: 0.88 })
  }

  public playVictory() {
    this.duckBgm(2.0, 0.3)
    this.playSample('victory', { volume: 0.88 })
    this.playHeroVoice('signature', 0.18, 0)
  }

  public setDangerAlarm(active: boolean) {
    this.alarmDesired = active
    if (!active || this.muted || this.disposed) {
      this.stopAlarmLoop()
      return
    }
    if (this.alarmSource) return

    const key: SfxKey = 'timer-classic'
    const startLoop = (buffer: AudioBuffer) => {
      if (!this.alarmDesired || this.muted || this.disposed || this.alarmSource) return
      const ctx = this.ensureContext()
      if (!ctx || !this.compressor) return
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      const gain = ctx.createGain()
      gain.gain.value = 0.42
      src.connect(gain).connect(this.compressor)
      src.start()
      this.alarmSource = src
      this.alarmGain = gain
    }

    const ready = this.buffers.get(key)
    if (ready) {
      startLoop(ready)
      return
    }
    void this.loadSample(key).then((buf) => {
      if (buf) startLoop(buf)
    })
  }

  private stopAlarmLoop() {
    if (this.alarmSource) {
      try {
        this.alarmSource.stop()
        this.alarmSource.disconnect()
      } catch {
        // 节点已停止时忽略
      }
      this.alarmSource = null
    }
    if (this.alarmGain) {
      try {
        this.alarmGain.disconnect()
      } catch {
        // 忽略断开异常
      }
      this.alarmGain = null
    }
  }

  public dispose() {
    this.disposed = true
    this.alarmDesired = false
    this.stopAlarmLoop()
    try {
      this.chargeOsc?.stop()
      this.chargeOsc?.disconnect()
    } catch {
      // 忽略已停止异常
    }
    try {
      this.ambSource?.stop()
      this.ambSource?.disconnect()
    } catch {
      // 忽略已停止异常
    }
    this.chargeOsc = null
    this.chargeGain = null
    this.ambSource = null
    this.ambFilter = null
    this.ambGain = null
    this.buffers.clear()
    this.loading.clear()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
      this.masterGain = null
      this.compressor = null
    }
  }
}
