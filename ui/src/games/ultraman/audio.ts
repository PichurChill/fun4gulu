/**
 * 特摄战斗合成音效引擎（纯 WebAudio，零外部音频依赖）
 */
export class UltraAudio {
  private ctx: AudioContext | null = null
  public muted = false
  private alarmTimer: number | null = null

  private ensureContext(): AudioContext | null {
    if (this.muted) return null
    try {
      if (!this.ctx) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        this.ctx = new AudioCtx()
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume()
      }
      return this.ctx
    } catch {
      return null
    }
  }

  public unlock() {
    this.ensureContext()
  }

  /** 变身闪光音效 */
  public playTransform() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const freqs = [261.63, 392.0, 523.25, 783.99, 1046.5]
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = idx % 2 === 0 ? 'triangle' : 'sine'
      osc.frequency.setValueAtTime(f * 0.75, now + idx * 0.06)
      osc.frequency.exponentialRampToValueAtTime(f * 1.4, now + 0.55 + idx * 0.05)
      gain.gain.setValueAtTime(0.001, now + idx * 0.06)
      gain.gain.linearRampToValueAtTime(0.09, now + 0.15 + idx * 0.06)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.95)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + idx * 0.06)
      osc.stop(now + 1.0)
    })
  }

  /** 拳风从出招侧掠向中央，飞踢的扫频更低、尾音更长。 */
  public playSwing(side: 'left' | 'right', kick: boolean) {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const duration = kick ? 0.14 : 0.09
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const wind = ctx.createBufferSource()
    wind.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(kick ? 650 : 1050, now)
    filter.frequency.exponentialRampToValueAtTime(kick ? 1650 : 2900, now + duration)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.38, now + duration * 0.4)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
    const pan = ctx.createStereoPanner()
    pan.pan.setValueAtTime(side === 'left' ? -0.65 : 0.65, now)
    pan.pan.linearRampToValueAtTime(0, now + duration)
    wind.connect(filter).connect(gain).connect(pan).connect(ctx.destination)
    wind.start(now)
  }

  /** 出拳呼啸与命中重击 */
  public playPunch(hit = true) {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime

    // 拳风低频冲击
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(hit ? 220 : 320, now)
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.16)
    gain.gain.setValueAtTime(hit ? 0.28 : 0.14, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.19)

    if (hit) {
      // 打击感：胸口共振的次低音重锤
      const sub = ctx.createOscillator()
      const subGain = ctx.createGain()
      sub.type = 'sine'
      sub.frequency.setValueAtTime(86, now)
      sub.frequency.exponentialRampToValueAtTime(34, now + 0.13)
      subGain.gain.setValueAtTime(0.34, now)
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15)
      sub.connect(subGain)
      subGain.connect(ctx.destination)
      sub.start(now)
      sub.stop(now + 0.16)
      this.playNoiseBurst(0.12, 0.22, 950)
    }
  }

  /** 重招劈斩命中（飞踢 / 光轮 / 光线爆点）：高频破空 + 低频重击复合 */
  public playHeavyImpact() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime

    // 金属高频劈裂
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(1750, now)
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.12)
    gain.gain.setValueAtTime(0.16, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 420
    osc.connect(hp)
    hp.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.15)

    // 低频冲击底气
    const sub = ctx.createOscillator()
    const subGain = ctx.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(96, now)
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.2)
    subGain.gain.setValueAtTime(0.4, now)
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
    sub.connect(subGain)
    subGain.connect(ctx.destination)
    sub.start(now)
    sub.stop(now + 0.23)

    this.playNoiseBurst(0.16, 0.26, 1400)
  }

  /** 八分光轮嗡鸣飞斩 */
  public playDisc() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    const gain = ctx.createGain()

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(620, now)
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.25)
    osc.frequency.exponentialRampToValueAtTime(460, now + 0.6)

    lfo.frequency.value = 34
    lfoGain.gain.value = 90
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1400
    filter.Q.value = 2.4

    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.62)

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    lfo.start(now)
    osc.stop(now + 0.64)
    lfo.stop(now + 0.64)
  }

  /** 哉佩利敖光线发射轰鸣 */
  public playBeam(isSuper = false) {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const dur = isSuper ? 1.85 : 1.35

    // 高频共鸣光束声
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()
    osc1.type = 'sawtooth'
    osc2.type = 'sine'
    osc1.frequency.setValueAtTime(340, now)
    osc1.frequency.exponentialRampToValueAtTime(isSuper ? 960 : 720, now + 0.22)
    osc1.frequency.linearRampToValueAtTime(520, now + dur)

    osc2.frequency.setValueAtTime(680, now)
    osc2.frequency.exponentialRampToValueAtTime(isSuper ? 1560 : 1180, now + 0.24)
    osc2.frequency.linearRampToValueAtTime(880, now + dur)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2800, now)
    filter.frequency.linearRampToValueAtTime(1200, now + dur)

    gain.gain.setValueAtTime(0.01, now)
    gain.gain.linearRampToValueAtTime(isSuper ? 0.24 : 0.18, now + 0.12)
    gain.gain.setValueAtTime(isSuper ? 0.22 : 0.16, now + dur - 0.35)
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur)

    osc1.connect(filter)
    osc2.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    osc1.start(now)
    osc2.start(now)
    osc1.stop(now + dur + 0.05)
    osc2.stop(now + dur + 0.05)

    this.playNoiseBurst(dur * 0.7, isSuper ? 0.18 : 0.12, 650)
  }

  /** 奥特屏障格挡成功 */
  public playGuardBlock() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(540, now)
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.16)
    gain.gain.setValueAtTime(0.22, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.28)

    // 金属屏障共鸣余韵（微失谐双振荡器）
    for (const detune of [1318, 1332]) {
      const ring = ctx.createOscillator()
      const ringGain = ctx.createGain()
      ring.type = 'sine'
      ring.frequency.value = detune
      ringGain.gain.setValueAtTime(0.07, now)
      ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34)
      ring.connect(ringGain)
      ringGain.connect(ctx.destination)
      ring.start(now)
      ring.stop(now + 0.36)
    }
  }

  /** 英雄受击沉闷冲击 */
  public playHeroHurt() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(160, now)
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.28)
    gain.gain.setValueAtTime(0.26, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.32)

    // 受击次低音钝击，把“挨了一记重的”砸进身体里
    const sub = ctx.createOscillator()
    const subGain = ctx.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(72, now)
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.24)
    subGain.gain.setValueAtTime(0.36, now)
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.26)
    sub.connect(subGain)
    subGain.connect(ctx.destination)
    sub.start(now)
    sub.stop(now + 0.27)

    this.playNoiseBurst(0.22, 0.25, 420)
  }

  /** 怪兽攻击预警提示音 */
  public playRoar() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const t = ctx.currentTime
    const voice = ctx.createOscillator()
    const throat = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    voice.type = 'sawtooth'
    voice.frequency.setValueAtTime(48, t)
    voice.frequency.exponentialRampToValueAtTime(92, t + 0.19)
    voice.frequency.exponentialRampToValueAtTime(36, t + 0.85)
    throat.type = 'bandpass'
    throat.frequency.setValueAtTime(390, t)
    throat.frequency.exponentialRampToValueAtTime(770, t + 0.22)
    throat.frequency.exponentialRampToValueAtTime(250, t + 0.84)
    throat.Q.value = 1.4
    gain.gain.setValueAtTime(0.001, t)
    gain.gain.linearRampToValueAtTime(0.38, t + 0.14)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
    voice.connect(throat).connect(gain).connect(ctx.destination)
    voice.start(t)
    voice.stop(t + 0.92)
    this.playNoiseBurst(0.55, 0.19, 550)
  }

  public playWarning() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.setValueAtTime(580, now + i * 0.14)
      osc.frequency.linearRampToValueAtTime(440, now + i * 0.14 + 0.1)
      gain.gain.setValueAtTime(0.09, now + i * 0.14)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.11)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.14)
      osc.stop(now + i * 0.14 + 0.12)
    }
  }

  /** 怪兽被击败大爆炸 */
  public playExplosion() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(120, now)
    osc.frequency.exponentialRampToValueAtTime(24, now + 0.75)
    gain.gain.setValueAtTime(0.32, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.82)
    this.playNoiseBurst(0.75, 0.34, 380)
  }

  /** 胜利凯旋音阶 */
  public playVictory() {
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((n, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(n, now + i * 0.12)
      gain.gain.setValueAtTime(0.16, now + i * 0.12)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.45)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.12)
      osc.stop(now + i * 0.12 + 0.48)
    })
  }

  /** 经典彩色计时器红灯“叮咚”闪烁警报 */
  public setDangerAlarm(active: boolean) {
    if (!active) {
      if (this.alarmTimer !== null) {
        window.clearInterval(this.alarmTimer)
        this.alarmTimer = null
      }
      return
    }
    if (this.alarmTimer !== null) return
    const ping = () => {
      const ctx = this.ensureContext()
      if (!ctx) return
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(988, now)
      gain.gain.setValueAtTime(0.08, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.2)
    }
    ping()
    this.alarmTimer = window.setInterval(ping, 720)
  }

  private playNoiseBurst(duration: number, volume: number, cutoffHz: number) {
    const ctx = this.ensureContext()
    if (!ctx) return
    const sampleCount = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < sampleCount; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / sampleCount)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = cutoffHz
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(volume, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    source.start()
  }

  public dispose() {
    this.setDangerAlarm(false)
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }
}
