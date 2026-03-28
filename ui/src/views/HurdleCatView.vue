<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()

// ---- 状态 ----
const running = ref(false)
const score = ref(0)
const combo = ref(0)
const showCombo = ref(false)
const debugMode = ref(false)
const calibrated = ref(false)

// ---- DOM refs ----
const videoRef = ref<HTMLVideoElement | null>(null)
const poseCanvasRef = ref<HTMLCanvasElement | null>(null)
const gameCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---- Canvas contexts (non-reactive) ----
let poseCtx: CanvasRenderingContext2D | null = null
let gameCtx: CanvasRenderingContext2D | null = null

// ---- 音频 ----
let audioCtx: AudioContext | null = null
function playJumpSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = 'square'
    osc.frequency.setValueAtTime(400, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1)
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.15)
  } catch {}
}

function playHitSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(200, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.2)
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.2)
  } catch {}
}

// ---- 伪3D道路系统 ----
const road = {
  vanishingY: 0,      // 消失点Y坐标
  roadTopY: 0,         // 道路顶部Y
  roadBottomY: 0,      // 道路底部Y
  roadTopWidth: 0,     // 道路顶部宽度
  roadBottomWidth: 0,  // 道路底部宽度
  scrollOffset: 0,     // 滚动偏移量
  segments: 20,        // 道路分段数

  init(cw: number, ch: number) {
    this.vanishingY = ch * 0.3
    this.roadTopY = this.vanishingY
    this.roadBottomY = ch * 0.92
    this.roadTopWidth = cw * 0.02
    this.roadBottomWidth = cw * 0.7
    this.scrollOffset = 0
  },

  // 根据深度获取道路的Y坐标和宽度
  getRoadAtDepth(depth: number, cw: number, ch: number): { y: number; width: number; scale: number } {
    // depth: 0(远) -> 1(近)
    const t = depth
    const y = this.roadTopY + (this.roadBottomY - this.roadTopY) * t * t
    const width = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * t
    const scale = 0.1 + t * 0.9
    return { y, width, scale }
  },

  update() {
    this.scrollOffset = (this.scrollOffset + 8) % 64
  },

  draw(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    // 绘制天空渐变
    const skyGradient = ctx.createLinearGradient(0, 0, 0, this.vanishingY)
    skyGradient.addColorStop(0, '#1a1a40')
    skyGradient.addColorStop(1, '#4a4a80')
    ctx.fillStyle = skyGradient
    ctx.fillRect(0, 0, cw, this.vanishingY)

    // 绘制地面（草地）
    ctx.fillStyle = '#2d5a27'
    ctx.fillRect(0, this.vanishingY, cw, ch - this.vanishingY)

    // 绘制道路分段
    for (let i = this.segments; i >= 0; i--) {
      const depth1 = i / this.segments
      const depth2 = (i + 1) / this.segments
      const seg1 = this.getRoadAtDepth(depth1, cw, ch)
      const seg2 = this.getRoadAtDepth(depth2, cw, ch)

      // 计算条纹颜色（交替）
      const stripeIndex = Math.floor((i + this.scrollOffset / 4) % 4)
      const isLight = stripeIndex < 2
      const roadColor = isLight ? '#555555' : '#444444'
      const grassColor = isLight ? '#3a6b34' : '#2d5a27'

      // 绘制草地分段
      ctx.fillStyle = grassColor
      ctx.fillRect(0, seg1.y, cw, seg2.y - seg1.y + 1)

      // 绘制道路分段（梯形）
      ctx.fillStyle = roadColor
      ctx.beginPath()
      ctx.moveTo(cw / 2 - seg1.width / 2, seg1.y)
      ctx.lineTo(cw / 2 + seg1.width / 2, seg1.y)
      ctx.lineTo(cw / 2 + seg2.width / 2, seg2.y)
      ctx.lineTo(cw / 2 - seg2.width / 2, seg2.y)
      ctx.closePath()
      ctx.fill()

      // 道路边线
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(1, 3 * seg2.scale)
      ctx.beginPath()
      ctx.moveTo(cw / 2 - seg2.width / 2, seg2.y)
      ctx.lineTo(cw / 2 - seg1.width / 2, seg1.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cw / 2 + seg2.width / 2, seg2.y)
      ctx.lineTo(cw / 2 + seg1.width / 2, seg1.y)
      ctx.stroke()

      // 道路中线（虚线）
      if (stripeIndex % 2 === 0) {
        ctx.strokeStyle = '#ffff00'
        ctx.lineWidth = Math.max(1, 2 * seg2.scale)
        ctx.setLineDash([10 * seg2.scale, 10 * seg2.scale])
        ctx.lineDashOffset = -this.scrollOffset * seg2.scale
        ctx.beginPath()
        ctx.moveTo(cw / 2, seg1.y)
        ctx.lineTo(cw / 2, seg2.y)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }
}

// ---- 栏杆系统 ----
interface Hurdle {
  z: number        // 深度 0(远) -> 1(近)
  x: number        // 相对位置 -1(左) -> 0(中) -> 1(右)
  hit: boolean
  rotation: number
  vx: number
  vy: number
  alpha: number
}

const hurdles: Hurdle[] = []
const hurdleSpawnTimer = ref(0)
const HURDLE_SPAWN_INTERVAL = 150

function spawnHurdle() {
  // 随机左右位置，但偏中心
  const xOffset = (Math.random() - 0.5) * 0.6 // -0.3 到 0.3
  hurdles.push({
    z: 0,
    x: xOffset,
    hit: false,
    rotation: 0,
    vx: 0,
    vy: 0,
    alpha: 1
  })
}

function updateHurdles() {
  const catY = cat.y
  const jumpHeight = (cat.baseY - catY) / cat.jumpHeight

  for (let i = hurdles.length - 1; i >= 0; i--) {
    const h = hurdles[i]!

    if (h.hit) {
      // 被撞飞动画
      h.x += h.vx
      h.z += 0.02
      h.rotation += h.vx * 0.5
      h.alpha -= 0.02

      if (h.alpha <= 0 || h.z > 1.5) {
        hurdles.splice(i, 1)
      }
      continue
    }

    // 正常移动：从远到近
    h.z += 0.012

    // 碰撞检测：当栏杆到达猫的位置
    if (h.z > 0.92 && h.z < 0.98) {
      // 检查是否跳跃足够高
      if (jumpHeight > 0.4) {
        // 成功跳跃
        score.value++
        combo.value++
        if (combo.value > 1) showCombo.value = true
        if (comboTimer) clearTimeout(comboTimer)
        comboTimer = setTimeout(() => { combo.value = 0; showCombo.value = false }, 2000)
        spawnFloatingText(window.innerWidth / 2, cat.y - 100, combo.value > 1 ? `+${combo.value}` : '+1', '#FFD700')
        playJumpSound()
        hurdles.splice(i, 1)
      } else {
        // 撞到栏杆
        h.hit = true
        h.vx = h.x > 0 ? 0.03 : -0.03
        score.value = Math.max(0, score.value - 1)
        combo.value = 0
        showCombo.value = false
        spawnFloatingText(window.innerWidth / 2, cat.y - 60, '-1', '#e63946')
        playHitSound()
        // 屏幕震动
        shakeScreen()
      }
    }

    // 移除超出屏幕的栏杆
    if (h.z > 1.3) {
      hurdles.splice(i, 1)
    }
  }

  // 生成新栏杆
  hurdleSpawnTimer.value++
  if (hurdleSpawnTimer.value >= HURDLE_SPAWN_INTERVAL) {
    spawnHurdle()
    hurdleSpawnTimer.value = 0
  }
}

function drawHurdles(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
  // 按z坐标排序，先画远的
  hurdles.sort((a, b) => a.z - b.z)

  for (const h of hurdles) {
    const roadData = road.getRoadAtDepth(h.z, cw, ch)
    const hurdleX = cw / 2 + h.x * roadData.width
    const hurdleY = roadData.y
    const scale = roadData.scale

    ctx.save()
    ctx.globalAlpha = h.alpha

    if (h.hit) {
      // 被撞飞的栏杆
      ctx.translate(hurdleX, hurdleY)
      ctx.rotate(h.rotation)
      drawHurdleSprite(ctx, 0, 0, scale * 120, scale * 60, true)
    } else {
      // 正常栏杆
      ctx.translate(hurdleX, hurdleY)
      drawHurdleSprite(ctx, 0, 0, scale * 120, scale * 60, false)
    }

    ctx.restore()
  }
}

function drawHurdleSprite(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, isHit: boolean) {
  // 水管风格栏杆（红白机风格）
  const pipeColor = isHit ? '#888888' : '#cc3333'
  const capColor = isHit ? '#666666' : '#999999'

  // 左支柱
  ctx.fillStyle = pipeColor
  ctx.fillRect(x - w * 0.35, y, w * 0.08, h)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = Math.max(1, w * 0.02)
  ctx.strokeRect(x - w * 0.35, y, w * 0.08, h)

  // 右支柱
  ctx.fillStyle = pipeColor
  ctx.fillRect(x + w * 0.27, y, w * 0.08, h)
  ctx.strokeRect(x + w * 0.27, y, w * 0.08, h)

  // 横杆
  ctx.fillStyle = capColor
  ctx.fillRect(x - w * 0.4, y - h * 0.3, w * 0.8, h * 0.35)
  ctx.strokeRect(x - w * 0.4, y - h * 0.3, w * 0.8, h * 0.35)

  // 高光
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.fillRect(x - w * 0.33, y, w * 0.02, h)
  ctx.fillRect(x + w * 0.29, y, w * 0.02, h)
}

// ---- 屏幕震动 ----
let shakeIntensity = 0
function shakeScreen() {
  shakeIntensity = 8
}

// ---- 猫咪（背面视角）----
const cat = {
  x: 0,
  y: 0,
  baseY: 0,
  vy: 0,
  gravity: 0.9,
  jumpForce: -20,
  jumpHeight: 150,
  isJumping: false,
  tailWag: 0,

  reset(cw: number, ch: number) {
    this.baseY = ch * 0.78
    this.x = cw / 2
    this.y = this.baseY
    this.vy = 0
    this.isJumping = false
  },

  jump() {
    if (this.isJumping) return
    this.vy = this.jumpForce
    this.isJumping = true
    playJumpSound()
  },

  update() {
    this.vy += this.gravity
    this.y += this.vy
    if (this.y >= this.baseY) {
      this.y = this.baseY
      this.vy = 0
      this.isJumping = false
    }
    this.tailWag += 0.15
  },

  draw(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    const scale = 1.2
    const cx = this.x
    const cy = this.y

    ctx.save()

    // 跳跃时的阴影效果
    if (this.isJumping) {
      const shadowScale = 1 - (this.baseY - this.y) / this.jumpHeight * 0.3
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.beginPath()
      ctx.ellipse(cx, this.baseY + 20, 40 * shadowScale, 15 * shadowScale, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    // 身体（椭圆，背面视角）
    ctx.fillStyle = '#FFB347'
    ctx.strokeStyle = '#E8A030'
    ctx.lineWidth = 2

    // 主体
    ctx.beginPath()
    ctx.ellipse(cx, cy, 35 * scale, 45 * scale, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // 身体阴影效果
    ctx.fillStyle = 'rgba(0,0,0,0.1)'
    ctx.beginPath()
    ctx.ellipse(cx + 10, cy + 10, 25 * scale, 35 * scale, 0, 0, Math.PI * 2)
    ctx.fill()

    // 后背条纹（橘猫特征）
    ctx.strokeStyle = '#E8A030'
    ctx.lineWidth = 3
    for (let i = 0; i < 3; i++) {
      const stripeY = cy - 20 + i * 20
      ctx.beginPath()
      ctx.moveTo(cx - 15, stripeY)
      ctx.quadraticCurveTo(cx, stripeY - 5, cx + 15, stripeY)
      ctx.stroke()
    }

    // 屁股部分（稍微突出）
    ctx.fillStyle = '#FFB347'
    ctx.beginPath()
    ctx.ellipse(cx, cy + 35 * scale, 30 * scale, 25 * scale, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // 尾巴（摆动）
    const tailWagOffset = Math.sin(this.tailWag) * 15
    ctx.strokeStyle = '#E8A030'
    ctx.lineWidth = 8
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, cy + 50 * scale)
    ctx.quadraticCurveTo(
      cx + tailWagOffset,
      cy + 70 * scale,
      cx + tailWagOffset * 1.5,
      cy + 50 * scale
    )
    ctx.stroke()

    // 尾巴尖（白色）
    ctx.strokeStyle = '#FFF'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo(cx + tailWagOffset * 1.3, cy + 58 * scale)
    ctx.lineTo(cx + tailWagOffset * 1.5, cy + 50 * scale)
    ctx.stroke()

    // 后腿（简化为椭圆）
    ctx.fillStyle = '#FFB347'
    // 左后腿
    ctx.beginPath()
    ctx.ellipse(cx - 20 * scale, cy + 40 * scale, 12 * scale, 18 * scale, -0.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // 右后腿
    ctx.beginPath()
    ctx.ellipse(cx + 20 * scale, cy + 40 * scale, 12 * scale, 18 * scale, 0.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // 脚掌
    ctx.fillStyle = '#FFD1DC'
    ctx.beginPath()
    ctx.ellipse(cx - 20 * scale, cy + 52 * scale, 8 * scale, 6 * scale, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx + 20 * scale, cy + 52 * scale, 8 * scale, 6 * scale, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }
}

// ---- 粒子 ----
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }
const particles: Particle[] = []
function spawnParticles(x: number, y: number) {
  const colors = ['#FFB347', '#FFD1DC', '#FF6B6B', '#FFF', '#FFD700']
  for (let i = 0; i < 10; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 8,
      vy: -Math.random() * 6 - 2,
      life: 1,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      size: Math.random() * 8 + 4
    })
  }
}
function updateAndDrawParticles(ctx: CanvasRenderingContext2D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.x += p.vx
    p.y += p.vy
    p.vy += 0.2
    p.life -= 0.025
    if (p.life <= 0) { particles.splice(i, 1); continue }
    ctx.globalAlpha = p.life
    ctx.fillStyle = p.color
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
  }
  ctx.globalAlpha = 1
}

// ---- 飘字 ----
interface FloatingText { x: number; y: number; text: string; life: number; color: string }
const floatingTexts: FloatingText[] = []
function spawnFloatingText(x: number, y: number, text: string, color = '#FFD700') {
  floatingTexts.push({ x, y, text, life: 1, color })
}
function updateAndDrawFloatingTexts(ctx: CanvasRenderingContext2D) {
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const t = floatingTexts[i]!
    t.y -= 2
    t.life -= 0.02
    if (t.life <= 0) { floatingTexts.splice(i, 1); continue }
    ctx.globalAlpha = t.life
    ctx.fillStyle = t.color
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 4
    ctx.font = 'bold 32px sans-serif'
    ctx.textAlign = 'center'
    ctx.strokeText(t.text, t.x, t.y)
    ctx.fillText(t.text, t.x, t.y)
  }
  ctx.globalAlpha = 1
}

// ---- 跳跃检测 ----
const jumpDetector = {
  history: [] as number[],
  maxHistory: 15,
  baseline: null as number | null,
  baselineSamples: [] as number[],
  jumping: false,
  lastJumpTime: 0,
  jumpCooldown: 400,
  reset() {
    this.history = []
    this.baseline = null
    this.baselineSamples = []
    this.jumping = false
    this.lastJumpTime = 0
    calibrated.value = false
  },
  detect(hipY: number): boolean {
    if (!hipY || hipY <= 0 || hipY >= 1) return false
    if (!this.baseline) {
      this.baselineSamples.push(hipY)
      if (this.baselineSamples.length >= 15) {
        const sorted = [...this.baselineSamples].sort((a, b) => a - b)
        this.baseline = sorted[Math.floor(sorted.length / 2)] ?? null
        calibrated.value = true
      }
      return false
    }
    this.history.push(hipY)
    if (this.history.length > this.maxHistory) this.history.shift()
    if (this.history.length < 8) return false
    const threshold = 0.03
    const recent = this.history.slice(-5)
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length
    if (!this.jumping && (this.baseline - avgRecent) > threshold) {
      this.jumping = true
      return false
    }
    if (this.jumping && avgRecent >= this.baseline - threshold * 0.5) {
      this.jumping = false
      const now = Date.now()
      if (now - this.lastJumpTime < this.jumpCooldown) return false
      this.lastJumpTime = now
      return true
    }
    return false
  }
}

// ---- 连击 ----
let comboTimer: ReturnType<typeof setTimeout> | null = null

// ---- 游戏循环 ----
let animFrameId = 0
function gameLoop() {
  if (!running.value) return
  if (!gameCtx) return

  const w = gameCanvasRef.value!.width
  const h = gameCanvasRef.value!.height

  // 屏幕震动
  let shakeX = 0, shakeY = 0
  if (shakeIntensity > 0) {
    shakeX = (Math.random() - 0.5) * shakeIntensity
    shakeY = (Math.random() - 0.5) * shakeIntensity
    shakeIntensity *= 0.8
    if (shakeIntensity < 0.5) shakeIntensity = 0
  }

  // 清空画布
  gameCtx.clearRect(0, 0, w, h)

  gameCtx.save()
  gameCtx.translate(shakeX, shakeY)

  // 更新和绘制道路
  road.update()
  road.draw(gameCtx, w, h)

  // 更新和绘制栏杆
  updateHurdles()
  drawHurdles(gameCtx, w, h)

  // 更新和绘制猫
  cat.update()
  cat.draw(gameCtx, w, h)

  // 粒子和飘字
  updateAndDrawParticles(gameCtx)
  updateAndDrawFloatingTexts(gameCtx)

  gameCtx.restore()

  animFrameId = requestAnimationFrame(gameLoop)
}

// ---- MediaPipe ----
let poseInstance: any = null
let cameraInstance: any = null

function initPose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poseInstance = new (window as any).Pose({
    locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
  })
  poseInstance.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  poseInstance.onResults(onPoseResults)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onPoseResults(results: any) {
  if (!poseCtx || !poseCanvasRef.value) return
  poseCtx.clearRect(0, 0, poseCanvasRef.value.width, poseCanvasRef.value.height)
  if (!results.poseLandmarks) return

  if (debugMode.value) {
    poseCtx.save()
    poseCtx.translate(poseCanvasRef.value.width, 0)
    poseCtx.scale(-1, 1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).drawConnectors(poseCtx, results.poseLandmarks, (window as any).POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).drawLandmarks(poseCtx, results.poseLandmarks, { color: '#FF0000', lineWidth: 1, radius: 3 })
    poseCtx.restore()
  }

  if (!running.value) return

  const leftHip = results.poseLandmarks[23]
  const rightHip = results.poseLandmarks[24]
  if (leftHip && rightHip) {
    const hipY = (leftHip.y + rightHip.y) / 2
    if (jumpDetector.detect(hipY)) cat.jump()
  }
}

// ---- Canvas 尺寸 ----
function resizeCanvases() {
  const w = window.innerWidth
  const h = window.innerHeight
  if (poseCanvasRef.value) {
    poseCanvasRef.value.width = w
    poseCanvasRef.value.height = h
  }
  if (gameCanvasRef.value) {
    gameCanvasRef.value.width = w
    gameCanvasRef.value.height = h
  }
  road.init(w, h)
  cat.baseY = h * 0.78
  cat.x = w / 2
  if (!cat.isJumping) cat.y = cat.baseY
}

// ---- 游戏流程 ----
async function startGame() {
  if (!videoRef.value) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } }
    })
    videoRef.value.srcObject = stream
    await videoRef.value.play()

    poseCtx = poseCanvasRef.value?.getContext('2d') ?? null
    gameCtx = gameCanvasRef.value?.getContext('2d') ?? null
    resizeCanvases()
    initPose()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cameraInstance = new (window as any).Camera(videoRef.value, {
      onFrame: async () => { if (poseInstance) await poseInstance.send({ image: videoRef.value }) },
      width: 480,
      height: 360,
    })
    cameraInstance.start()

    running.value = true
    score.value = 0
    combo.value = 0
    showCombo.value = false
    jumpDetector.reset()
    cat.reset(window.innerWidth, window.innerHeight)
    hurdles.length = 0
    particles.length = 0
    floatingTexts.length = 0
    hurdleSpawnTimer.value = 0
    shakeIntensity = 0
    gameLoop()
  } catch (err: any) {
    alert('无法启动摄像头或 MediaPipe：\n' + err.message)
  }
}

function stopGame() {
  running.value = false
  cancelAnimationFrame(animFrameId)
  if (cameraInstance) cameraInstance.stop()
  const stream = videoRef.value?.srcObject as MediaStream | null
  if (stream) stream.getTracks().forEach(t => t.stop())
}

function toggleDebug() {
  debugMode.value = !debugMode.value
}

function goBack() {
  stopGame()
  router.back()
}

onMounted(() => {
  // 动态加载 MediaPipe CDN scripts
  const scripts = [
    'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/pose.js',
    'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js',
    'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js',
  ]
  Promise.all(scripts.map(src => new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.crossOrigin = 'anonymous'
    s.onload = () => resolve()
    s.onerror = reject
    document.head.appendChild(s)
  })))
})

onUnmounted(() => {
  stopGame()
})
</script>

<template>
  <div class="hurdle-cat-page">
    <!-- 开始界面 -->
    <div v-if="!running" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.hurdleCatView.title') }}</h1>
        <p>{{ t('message.hurdleCatView.description') }}</p>
        <button class="start-btn" @click="startGame">{{ t('message.hurdleCatView.startButton') }}</button>
      </div>
    </div>

    <!-- 摄像头 -->
    <video ref="videoRef" autoplay playsinline class="camera-video" />

    <!-- 骨架层 -->
    <canvas ref="poseCanvasRef" class="layer-canvas" />

    <!-- 游戏层 -->
    <canvas ref="gameCanvasRef" class="layer-canvas game-layer" />

    <!-- UI 层 -->
    <div v-if="running" class="ui-layer">
      <!-- 顶部工具栏 -->
      <div class="top-bar">
        <button class="mario-btn" @click="goBack">&lt; {{ t('message.hurdleCatView.back') }}</button>
        <div class="score-box">{{ t('message.hurdleCatView.score') }}: {{ score }}</div>
        <div class="top-bar-right">
          <button class="mario-btn" :class="{ active: debugMode }" @click="toggleDebug">{{ t('message.hurdleCatView.debug') }}</button>
          <button class="mario-btn danger" @click="stopGame">{{ t('message.hurdleCatView.stop') }}</button>
        </div>
      </div>

      <div v-if="showCombo" class="combo-board" :key="combo">{{ t('message.hurdleCatView.combo') }} x{{ combo }}</div>

      <div v-if="!calibrated" class="calibrate-hint">
        {{ t('message.hurdleCatView.calibrating') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.hurdle-cat-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #1a1a2e;
}

.camera-video {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  object-fit: cover;
  transform: scaleX(-1);
  z-index: 1;
  opacity: 0.3;
}

.layer-canvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2;
}

.game-layer {
  z-index: 3;
}

.ui-layer {
  position: fixed;
  top: 80px;
  left: 0;
  width: 100vw;
  z-index: 10;
  pointer-events: none;
  padding: 0 30px;
  box-sizing: border-box;
}

/* 顶部工具栏 - 首页风格 */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: auto;
  background: #fff;
  border: 4px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 10px 20px;
}

.score-box {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #000;
}

.top-bar-right {
  display: flex;
  gap: 10px;
}

.mario-btn {
  background: #000;
  color: #fff;
  border: none;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.3);
  transition: transform 0.1s;
}

.mario-btn:hover {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.3);
}

.mario-btn:active {
  transform: translate(4px, 4px);
  box-shadow: none;
}

.mario-btn.danger {
  background: #e63946;
}

.mario-btn.active {
  background: #2a9d8f;
}

.combo-board {
  position: fixed;
  top: 160px;
  left: 50%;
  transform: translateX(-50%);
  background: #fff;
  border: 4px solid #000;
  box-shadow: 6px 6px 0 #000;
  color: #e63946;
  font-size: 28px;
  font-weight: 900;
  letter-spacing: 2px;
  padding: 8px 28px;
  animation: comboPulse 0.3s ease;
  pointer-events: none;
  z-index: 10;
}

@keyframes comboPulse {
  0% {
    transform: translateX(-50%) scale(1.2);
  }

  100% {
    transform: translateX(-50%) scale(1);
  }
}

.calibrate-hint {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #fff;
  border: 4px solid #000;
  box-shadow: 6px 6px 0 #000;
  color: #000;
  padding: 12px 28px;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 1px;
  animation: hintBounce 1.5s ease infinite;
  pointer-events: none;
  z-index: 10;
}

@keyframes hintBounce {
  0%,
  100% {
    transform: translate(-50%, -50%);
  }

  50% {
    transform: translate(-50%, calc(-50% - 10px));
  }
}

.overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 100;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.start-box {
  text-align: center;
  color: #000;
}

.start-box h1 {
  font-size: 64px;
  margin-bottom: 10px;
  font-weight: 950;
}

.start-box p {
  font-size: 18px;
  color: #666;
  margin-bottom: 30px;
  font-weight: 800;
  letter-spacing: 1px;
}

.start-btn {
  background: #000;
  color: #fff;
  border: none;
  padding: 18px 48px;
  font-size: 20px;
  font-weight: 900;
  letter-spacing: 2px;
  cursor: pointer;
  box-shadow: 6px 6px 0 #000;
  transition: transform 0.2s;
  position: relative;
}

.start-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: #cc3333;
  transform: translate(6px, 6px);
  z-index: -1;
}

.start-btn:hover {
  transform: translate(2px, 2px);
  box-shadow: 4px 4px 0 #000;
}

@media (max-width: 768px) {
  .start-box h1 {
    font-size: 40px;
  }

  .start-box p {
    font-size: 14px;
  }

  .start-btn {
    padding: 14px 32px;
    font-size: 16px;
  }

  .top-bar {
    padding: 8px 12px;
  }

  .score-box {
    font-size: 18px;
  }

  .mario-btn {
    padding: 6px 12px;
    font-size: 11px;
  }

  .combo-board {
    font-size: 20px;
    top: 150px;
  }
}
</style>
