import type { HeroId } from './types'

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
 * 电视特摄真实多轨采样音效引擎（预解码全套圆谷原声变身/战吼/光波/打击/怪兽/计时器素材）
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

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return null
      this.ctx = new AudioCtx()
      // 广播级软限幅母线：确保连招、战吼、光波与爆炸并发叠加时扎实饱满不削波破音
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

  /** 并行预解码全套 33 条电视特摄真实音效至内存，保障战斗出招零延迟 */
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

  /** 播放英雄原版电视战吼（带冷却节流，避免高频连拳人声重叠） */
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

  /** 变身器闪烁展开 / 巨大化变身登场 / 三形态切换原版电视音效 */
  public playTransform(kind: TransformSfxKind = 'rise') {
    if (kind === 'open') {
      this.playSample('transform-open', { volume: 0.84 })
      return
    }
    if (kind === 'type') {
      this.playSample('type-change', { volume: 0.88 })
      return
    }
    this.playSample('transform-rise', { volume: 0.92 })
    this.playHeroVoice('signature', 0.24, 0)
  }

  /** 拳风与飞踢破空呼啸（立体声定向 + 飞踢附带原声战吼） */
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

  /** 电视肉搏打击音效（双采样交替防机械重复 + 节奏穿插奥特曼原声战吼） */
  public playPunch(hit = true) {
    this.punchCounter++
    if (!hit) {
      this.playSample('swing', { volume: 0.45, rate: 1.08, rateJitter: 0.06 })
      return
    }
    const key: SfxKey = this.punchCounter % 2 === 0 ? 'punch-2' : 'punch-1'
    this.playSample(key, {
      volume: 0.82,
      rateJitter: 0.06,
    })
    if (this.punchCounter % 3 === 1) {
      this.playHeroVoice('light', 0.01, 460)
    }
  }

  /** 飞踢 / 终结连击 / 破防重击特摄爆火星重砸 */
  public playHeavyImpact() {
    this.playSample('heavy-impact', { volume: 0.92, rateJitter: 0.04 })
    this.playSample('clash-impact', { volume: 0.68, delay: 0.02, rateJitter: 0.04 })
    this.playHeroVoice('heavy', 0.02, 420)
  }

  /** 挥拳击碎/弹反怪兽火球的清脆高能爆鸣 */
  public playDeflect() {
    this.playSample('deflect', { volume: 0.85, rateJitter: 0.05 })
  }

  /** 极速侧闪破空风声 */
  public playDodge() {
    this.playSample('dodge', { volume: 0.64, rateJitter: 0.06 })
  }

  /** 双光线宿命对波持续高能轰鸣 */
  public playBeamClash() {
    this.playSample('beam-clash', { volume: 0.9 })
  }

  /** 八分光轮高压电光飞斩 */
  public playDisc() {
    this.playSample('disc', { volume: 0.86, rateJitter: 0.04 })
    this.playHeroVoice('light', 0.02, 260)
  }

  /** 电视原版必杀光线 / 终极超级光线轰射（附带英雄原声战吼） */
  public playBeam(isSuper = false) {
    if (isSuper) {
      this.playSample('beam-super', { volume: 0.96 })
      this.playSample('beam-normal', { volume: 0.72, delay: 0.14 })
      this.playHeroVoice('signature', 0.04, 0)
    } else {
      this.playSample('beam-normal', { volume: 0.9 })
      this.playHeroVoice('heavy', 0.02, 200)
    }
  }

  /** 立体球形奥特屏障格挡弹反原声 */
  public playGuardBlock() {
    this.playSample('guard-block', { volume: 0.9, rateJitter: 0.04 })
  }

  /** 英雄受击沉重冲击 */
  public playHeroHurt() {
    this.playSample('hero-hurt', { volume: 0.86, rate: 0.9, rateJitter: 0.05 })
  }

  /** 按当前怪兽精准触发电视原版怪兽咆哮（哥莫拉 / 巴尔坦 / 超兽 / 巨兽） */
  public playRoar(monsterId = this.monsterId) {
    let key: SfxKey = 'roar-kaiju-a'
    if (monsterId === 'gomora-mecha') key = 'roar-gomora'
    else if (monsterId === 'baltan') key = 'roar-baltan'
    else if (monsterId === 'gatanothor') key = 'roar-kaiju-b'
    this.playSample(key, { volume: 0.9, rateJitter: 0.03 })
  }

  /** 怪兽攻击前摇高能警报（复用平成计时器清脆短脉冲，告别刺耳电子方波） */
  public playWarning() {
    this.playSample('timer-heisei', { volume: 0.42, rate: 1.18, duration: 0.34 })
  }

  /** 电视特摄微缩都市连环大爆炸（双轨错位叠加震撼低频） */
  public playExplosion() {
    this.playSample('explosion-1', { volume: 0.92 })
    this.playSample('explosion-2', { volume: 0.86, delay: 0.14 })
  }

  /** 远程阶段掌心奥特光弹高速射击 */
  public playPalmShot() {
    this.playSample('palm-shot', { volume: 0.74, rateJitter: 0.08 })
  }

  /** 幕 3 角力推力胶着震动撞击 */
  public playGrapplePush() {
    this.playSample('clash-impact', {
      volume: 0.62,
      rate: 1.18,
      rateJitter: 0.08,
      duration: 0.36,
    })
  }

  /** 幕 4A 双臂展翼七彩棱镜聚能神圣共鸣 */
  public playRainbowCharge() {
    this.playSample('rainbow-charge', { volume: 0.82 })
  }

  /** 胜利合影清脆单反快门 */
  public playShutter() {
    this.playSample('shutter', { volume: 0.88 })
  }

  /** 胜利凯旋光辉 + 英雄招牌战吼 */
  public playVictory() {
    this.playSample('victory', { volume: 0.88 })
    this.playHeroVoice('signature', 0.18, 0)
  }

  /** 电视原版红灯彩色计时器“叮咚！叮咚！”循环警报 */
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
