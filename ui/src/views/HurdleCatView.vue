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
    osc.type = 'sine'
    osc.frequency.setValueAtTime(600, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1)
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.2)
  } catch {}
}

function playHitSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = 'square'
    osc.frequency.setValueAtTime(150, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.3)
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.3)
  } catch {}
}

// ---- 像素猫数据（复用 HomeView 的像素风格）----
const T = '' // transparent
const B = '#000'
const O = '#FF9933' // 橘猫主色
const D = '#CC7A00' // 暗橘色
const P = '#FFB6C1' // 粉色

const PX = 4

// 头部 + 身体
const catSharedRows = [
  [T,T,T,B,T,T,T,T,T,T,B],
  [T,T,B,O,B,T,T,T,T,B,O,B],
  [T,T,B,O,D,B,B,B,B,D,O,B,T,T,T,T,T,T,T,T,B,B],
  [T,B,D,O,O,D,D,O,D,O,O,D,B,T,T,T,T,T,T,B,O,O,B],
  [T,B,O,O,O,O,O,O,O,O,O,O,B,T,T,T,T,T,T,B,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,D,B,B,B,B,T,T,T,B,D,B],
  [B,O,O,B,O,O,B,O,O,B,O,O,O,D,O,D,O,B,T,T,B,O,B],
  [B,O,P,O,O,B,O,B,O,O,P,O,O,D,O,D,O,O,B,B,B,D,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B,O,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B,O,B],
  [B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B],
  [B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B],
  [T,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B],
]

// Frame A 腿部
const catLegsA = [
  [T,T,B,D,O,D,D,O,D,O,O,O,D,O,D,D,O,D,B],
  [T,T,T,B,O,B,B,O,B,B,B,B,B,O,B,B,O,B],
  [T,T,T,B,B,T,T,B,B,T,T,T,B,B,T,T,B,B],
]

// ---- 像素猫绘制函数 ----
function pixelize(grid: string[][], flip = false): string {
  const maxCols = Math.max(...grid.map(r => r.length))
  const shadows: string[] = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    if (!row) continue
    for (let x = 0; x < row.length; x++) {
      if (row[x] && row[x] !== T) {
        const px = flip ? (maxCols - 1 - x) : x
        shadows.push(`${px * PX}px ${y * PX}px 0 0 ${row[x]}`)
      }
    }
  }
  return shadows.join(',')
}

// 猫咪对象
const cat = {
  x: 0, y: 0, baseY: 0,
  vy: 0, gravity: 0.8, jumpForce: -18,
  isJumping: false,
  frame: 0,
  frameTimer: 0,
  size: 80,
  reset(cw: number, ch: number) {
    this.baseY = ch - 180
    this.x = cw * 0.25
    this.y = this.baseY
    this.vy = 0
    this.isJumping = false
    this.frame = 0
    this.frameTimer = 0
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

    // 动画帧更新
    this.frameTimer++
    if (this.frameTimer > 8) {
      this.frame = this.frame === 0 ? 1 : 0
      this.frameTimer = 0
    }
  },
  draw(ctx: CanvasRenderingContext2D) {
    const catData = this.frame === 0 ? [...catSharedRows, ...catLegsA] : [...catSharedRows, ...catLegsA]
    const shadows = pixelize(catData, false)

    ctx.save()
    ctx.translate(this.x - 60, this.y - 60)

    // 使用 box-shadow 绘制像素猫
    ctx.fillStyle = 'transparent'
    const el = document.createElement('div')
    el.style.width = '4px'
    el.style.height = '4px'
    el.style.boxShadow = shadows

    // 手动绘制像素
    const maxCols = Math.max(...catData.map(r => r.length))
    for (let y = 0; y < catData.length; y++) {
      const row = catData[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const color = row[x]
        if (color && color !== T) {
          ctx.fillStyle = color
          ctx.fillRect(x * PX, y * PX, PX, PX)
        }
      }
    }

    ctx.restore()
  }
}

// ---- 栏杆系统 ----
interface Hurdle {
  z: number // 深度 (0 = 远, 1 = 近)
  x: number // 屏幕x位置
  width: number
  height: number
  hit: boolean
  rotation: number
  vx: number
  vy: number
}

const hurdles: Hurdle[] = []
const hurdleSpawnTimer = ref(0)
const HURDLE_SPAWN_INTERVAL = 180 // 帧数
const groundScroll = ref(0)

function spawnHurdle() {
  hurdles.push({
    z: 0,
    x: 0.5, // 屏幕中央
    width: 0.08,
    height: 0.15,
    hit: false,
    rotation: 0,
    vx: 0,
    vy: 0
  })
}

// 透视转换：将3D坐标转换为2D屏幕坐标
function project(z: number, x: number): { screenX: number; scale: number } {
  // z: 0(远) -> 1(近)
  // 使用简单的透视投影
  const perspective = 0.3 + z * 0.7 // 缩放因子从0.3到1
  const screenX = window.innerWidth * (0.25 + (x - 0.5) * perspective * 2)
  return { screenX, scale: perspective }
}

function updateHurdles() {
  const catLeft = cat.x - 40
  const catRight = cat.x + 40
  const catBottom = cat.baseY
  const catTop = cat.y - 40

  for (let i = hurdles.length - 1; i >= 0; i--) {
    const h = hurdles[i]!

    if (h.hit) {
      // 被撞飞动画
      h.x += h.vx
      h.rotation += h.vx * 0.1
      h.vy += 0.3
      h.z += h.vy * 0.01

      if (h.z > 1.5 || h.x > 2) {
        hurdles.splice(i, 1)
      }
      continue
    }

    // 正常移动：从远到近
    h.z += 0.008

    // 碰撞检测
    if (h.z > 0.95 && h.z < 1.05) {
      const proj = project(h.z, h.x)
      const hurdleWidth = window.innerWidth * h.width * proj.scale
      const hurdleHeight = window.innerHeight * h.height * proj.scale
      const hurdleX = proj.screenX - hurdleWidth / 2
      const hurdleY = cat.baseY - hurdleHeight

      // 检查水平重叠
      if (hurdleX < catRight && hurdleX + hurdleWidth > catLeft) {
        // 检查垂直碰撞
        if (catTop > cat.baseY - hurdleHeight * 0.7) {
          // 撞到栏杆
          h.hit = true
          h.vx = 0.02
          h.vy = -5
          score.value = Math.max(0, score.value - 1)
          combo.value = 0
          showCombo.value = false
          playHitSound()
          spawnFloatingText(cat.x, cat.y - 60, '-1', '#e63946')
        } else {
          // 成功跳跃
          score.value++
          combo.value++
          if (combo.value > 1) {
            showCombo.value = true
          }
          if (comboTimer) clearTimeout(comboTimer)
          comboTimer = setTimeout(() => { combo.value = 0; showCombo.value = false }, 2000)
          spawnParticles(cat.x, cat.y + 40)
          spawnFloatingText(cat.x, cat.y - 80, combo.value > 1 ? `+${combo.value}` : '+1', '#FFD700')
        }
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

  // 地面滚动
  groundScroll.value = (groundScroll.value + 8) % 40
}

function drawHurdles(ctx: CanvasRenderingContext2D) {
  // 按z坐标排序，先画远的
  hurdles.sort((a, b) => a.z - b.z)

  for (const h of hurdles) {
    const proj = project(h.z, h.x)
    const scale = proj.scale
    const w = window.innerWidth * h.width * scale
    const hurdleHeight = window.innerHeight * h.height * scale
    const hx = proj.screenX - w / 2
    const hy = cat.baseY - hurdleHeight

    ctx.save()

    if (h.hit) {
      // 被撞飞的栏杆
      const hitProj = project(h.z, h.x)
      const hitScale = hitProj.scale
      const hitW = window.innerWidth * h.width * hitScale
      const hitH = window.innerHeight * h.height * hitScale
      const hitX = hitProj.screenX - hitW / 2
      const hitY = cat.baseY - hitH

      ctx.translate(hitX + hitW / 2, hitY + hitH / 2)
      ctx.rotate(h.rotation)
      ctx.translate(-(hitX + hitW / 2), -(hitY + hitH / 2))

      drawHurdle(ctx, hitX, hitY, hitW, hitH, true)
    } else {
      drawHurdle(ctx, hx, hy, w, hurdleHeight, false)
    }

    ctx.restore()
  }
}

function drawHurdle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, isHit: boolean) {
  // 绘制水管风格的栏杆
  const pipeColor = isHit ? '#a8dadc' : '#2a9d8f'
  const borderWidth = Math.max(3, w * 0.08)

  // 杆身
  ctx.fillStyle = pipeColor
  ctx.fillRect(x + w * 0.1, y + h * 0.4, w * 0.8, h * 0.6)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = borderWidth
  ctx.strokeRect(x + w * 0.1, y + h * 0.4, w * 0.8, h * 0.6)

  // 横杆（顶部）
  ctx.fillStyle = pipeColor
  ctx.fillRect(x, y, w, h * 0.5)
  ctx.strokeRect(x, y, w, h * 0.5)

  // 阴影效果
  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)'
  ctx.fillRect(x + w * 0.1 + w * 0.3, y + h * 0.4, w * 0.2, h * 0.6)

  // 高光
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.fillRect(x + w * 0.1, y + h * 0.4, w * 0.1, h * 0.6)
}

// ---- 粒子 ----
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }
const particles: Particle[] = []
function spawnParticles(x: number, y: number) {
  const colors = ['#FFB347', '#FFD1DC', '#FF6B6B', '#FFF']
  for (let i = 0; i < 8; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 6,
      vy: -Math.random() * 4 - 2,
      life: 1,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      size: Math.random() * 6 + 3
    })
  }
}
function updateAndDrawParticles(ctx: CanvasRenderingContext2D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.x += p.vx
    p.y += p.vy
    p.vy += 0.15
    p.life -= 0.025
    if (p.life <= 0) { particles.splice(i, 1); continue }
    ctx.globalAlpha = p.life
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
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
    ctx.font = 'bold 28px sans-serif'
    ctx.textAlign = 'center'
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

  // 清空画布
  gameCtx.clearRect(0, 0, w, h)

  // 绘制背景（天空渐变）
  const skyGradient = gameCtx.createLinearGradient(0, 0, 0, h)
  skyGradient.addColorStop(0, '#87CEEB')
  skyGradient.addColorStop(1, '#E0F7FA')
  gameCtx.fillStyle = skyGradient
  gameCtx.fillRect(0, 0, w, h)

  // 绘制地面
  const groundY = cat.baseY + 20
  gameCtx.fillStyle = '#8B4513'
  gameCtx.fillRect(0, groundY, w, h - groundY)

  // 绘制地面纹理（滚动效果）
  gameCtx.strokeStyle = '#654321'
  gameCtx.lineWidth = 3
  for (let i = 0; i < w + 40; i += 40) {
    const x = i - groundScroll.value
    gameCtx.beginPath()
    gameCtx.moveTo(x, groundY)
    gameCtx.lineTo(x, h)
    gameCtx.stroke()
  }

  // 更新和绘制栏杆
  updateHurdles()
  drawHurdles(gameCtx)

  // 更新和绘制猫
  cat.update()
  cat.draw(gameCtx)

  // 粒子和飘字
  updateAndDrawParticles(gameCtx)
  updateAndDrawFloatingTexts(gameCtx)

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
  cat.baseY = h - 180
  cat.x = w * 0.25
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
  background: #2a9d8f;
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
