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

// ---- 小猫 ----
const cat = {
  x: 0, y: 0, baseY: 0,
  vy: 0, gravity: 0.8, jumpForce: -18,
  isJumping: false,
  expression: 'normal' as 'normal' | 'happy',
  expressionTimer: 0,
  size: 80,
  reset(cw: number, ch: number) {
    this.baseY = ch - 150
    this.x = cw / 2
    this.y = this.baseY
    this.vy = 0
    this.isJumping = false
    this.expression = 'normal'
  },
  jump() {
    if (this.isJumping) return
    this.vy = this.jumpForce
    this.isJumping = true
    this.expression = 'happy'
    this.expressionTimer = 30
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
    if (this.expressionTimer > 0) this.expressionTimer--
    if (this.expressionTimer <= 0) this.expression = 'normal'
  },
  draw(ctx: CanvasRenderingContext2D) {
    const s = this.size
    const cx = this.x
    const cy = this.y
    const isHappy = this.expression === 'happy'
    ctx.save()

    // 身体
    ctx.fillStyle = '#FFB347'
    ctx.beginPath()
    ctx.ellipse(cx, cy, s * 0.45, s * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#E8A030'
    ctx.lineWidth = 2
    ctx.stroke()

    // 头
    ctx.beginPath()
    ctx.arc(cx, cy - s * 0.55, s * 0.38, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // 左耳
    ctx.fillStyle = '#FFB347'
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.28, cy - s * 0.75)
    ctx.lineTo(cx - s * 0.15, cy - s * 1.1)
    ctx.lineTo(cx - s * 0.02, cy - s * 0.75)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFD1DC'
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.24, cy - s * 0.8)
    ctx.lineTo(cx - s * 0.15, cy - s * 1.0)
    ctx.lineTo(cx - s * 0.06, cy - s * 0.8)
    ctx.closePath()
    ctx.fill()

    // 右耳
    ctx.fillStyle = '#FFB347'
    ctx.beginPath()
    ctx.moveTo(cx + s * 0.28, cy - s * 0.75)
    ctx.lineTo(cx + s * 0.15, cy - s * 1.1)
    ctx.lineTo(cx + s * 0.02, cy - s * 0.75)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFD1DC'
    ctx.beginPath()
    ctx.moveTo(cx + s * 0.24, cy - s * 0.8)
    ctx.lineTo(cx + s * 0.15, cy - s * 1.0)
    ctx.lineTo(cx + s * 0.06, cy - s * 0.8)
    ctx.closePath()
    ctx.fill()

    // 眼睛
    if (isHappy) {
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(cx - s * 0.13, cy - s * 0.55, s * 0.07, Math.PI, 0); ctx.stroke()
      ctx.beginPath(); ctx.arc(cx + s * 0.13, cy - s * 0.55, s * 0.07, Math.PI, 0); ctx.stroke()
    } else {
      ctx.fillStyle = '#333'
      ctx.beginPath(); ctx.arc(cx - s * 0.13, cy - s * 0.55, s * 0.06, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(cx + s * 0.13, cy - s * 0.55, s * 0.06, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx - s * 0.11, cy - s * 0.57, s * 0.025, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(cx + s * 0.15, cy - s * 0.57, s * 0.025, 0, Math.PI * 2); ctx.fill()
    }

    // 鼻子
    ctx.fillStyle = '#FF9999'
    ctx.beginPath()
    ctx.moveTo(cx, cy - s * 0.42)
    ctx.lineTo(cx - s * 0.04, cy - s * 0.38)
    ctx.lineTo(cx + s * 0.04, cy - s * 0.38)
    ctx.closePath(); ctx.fill()

    // 嘴
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.38); ctx.quadraticCurveTo(cx - s * 0.08, cy - s * 0.32, cx - s * 0.12, cy - s * 0.36); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.38); ctx.quadraticCurveTo(cx + s * 0.08, cy - s * 0.32, cx + s * 0.12, cy - s * 0.36); ctx.stroke()

    // 胡须
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(cx - s * 0.2, cy - s * 0.42); ctx.lineTo(cx - s * 0.45, cy - s * 0.48); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - s * 0.2, cy - s * 0.38); ctx.lineTo(cx - s * 0.45, cy - s * 0.38); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + s * 0.2, cy - s * 0.42); ctx.lineTo(cx + s * 0.45, cy - s * 0.48); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + s * 0.2, cy - s * 0.38); ctx.lineTo(cx + s * 0.45, cy - s * 0.38); ctx.stroke()

    // 腮红
    ctx.fillStyle = isHappy ? 'rgba(255,150,150,0.6)' : 'rgba(255,150,150,0.3)'
    ctx.beginPath(); ctx.ellipse(cx - s * 0.22, cy - s * 0.38, s * 0.08, s * 0.05, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(cx + s * 0.22, cy - s * 0.38, s * 0.08, s * 0.05, 0, 0, Math.PI * 2); ctx.fill()

    // 脚
    ctx.fillStyle = '#FFB347'
    ctx.beginPath(); ctx.ellipse(cx - s * 0.2, cy + s * 0.48, s * 0.1, s * 0.06, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.beginPath(); ctx.ellipse(cx + s * 0.2, cy + s * 0.48, s * 0.1, s * 0.06, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()

    // 尾巴
    ctx.strokeStyle = '#E8A030'; ctx.lineWidth = 5; ctx.lineCap = 'round'
    const tailWave = Math.sin(Date.now() / 200) * s * 0.15
    ctx.beginPath(); ctx.moveTo(cx + s * 0.35, cy + s * 0.2)
    ctx.quadraticCurveTo(cx + s * 0.65, cy - s * 0.1 + tailWave, cx + s * 0.55, cy - s * 0.4 + tailWave)
    ctx.stroke()

    ctx.restore()
  }
}

// ---- 粒子 ----
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }
const particles: Particle[] = []
function spawnParticles(x: number, y: number) {
  const colors = ['#FFB347', '#FFD1DC', '#FF6B6B', '#FFF']
  for (let i = 0; i < 8; i++) {
    particles.push({ x, y, vx: (Math.random() - 0.5) * 6, vy: -Math.random() * 4 - 2, life: 1, color: colors[Math.floor(Math.random() * colors.length)]!, size: Math.random() * 6 + 3 })
  }
}
function updateAndDrawParticles(ctx: CanvasRenderingContext2D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life -= 0.025
    if (p.life <= 0) { particles.splice(i, 1); continue }
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ---- 飘字 ----
interface FloatingText { x: number; y: number; text: string; life: number }
const floatingTexts: FloatingText[] = []
function spawnFloatingText(x: number, y: number, text: string) {
  floatingTexts.push({ x, y, text, life: 1 })
}
function updateAndDrawFloatingTexts(ctx: CanvasRenderingContext2D) {
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const t = floatingTexts[i]!
    t.y -= 2; t.life -= 0.02
    if (t.life <= 0) { floatingTexts.splice(i, 1); continue }
    ctx.globalAlpha = t.life; ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'
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
    this.history = []; this.baseline = null; this.baselineSamples = []; this.jumping = false; this.lastJumpTime = 0
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

// ---- 跳跃事件 ----
let comboTimer: ReturnType<typeof setTimeout> | null = null
function onJump() {
  cat.jump()
  score.value++
  combo.value++
  if (combo.value > 1) {
    showCombo.value = true
    // trigger reflow for animation
  }
  if (comboTimer) clearTimeout(comboTimer)
  comboTimer = setTimeout(() => { combo.value = 0; showCombo.value = false }, 2000)
  spawnParticles(cat.x, cat.y + cat.size * 0.4)
  spawnFloatingText(cat.x, cat.y - cat.size, combo.value > 1 ? `+${combo.value}` : '+1')
}

// ---- 游戏循环 ----
let animFrameId = 0
function gameLoop() {
  if (!running.value) return
  if (!gameCtx) return
  gameCtx.clearRect(0, 0, gameCanvasRef.value!.width, gameCanvasRef.value!.height)
  cat.update()
  updateAndDrawParticles(gameCtx)
  cat.draw(gameCtx)
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
    if (jumpDetector.detect(hipY)) onJump()
  }
}

// ---- Canvas 尺寸 ----
function resizeCanvases() {
  const w = window.innerWidth
  const h = window.innerHeight
  if (poseCanvasRef.value) { poseCanvasRef.value.width = w; poseCanvasRef.value.height = h }
  if (gameCanvasRef.value) { gameCanvasRef.value.width = w; gameCanvasRef.value.height = h }
  cat.baseY = h * 0.4
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
      width: 480, height: 360,
    })
    cameraInstance.start()

    running.value = true
    score.value = 0; combo.value = 0; showCombo.value = false
    jumpDetector.reset()
    cat.reset(window.innerWidth, window.innerHeight)
    particles.length = 0
    floatingTexts.length = 0
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
    s.src = src; s.crossOrigin = 'anonymous'; s.onload = () => resolve(); s.onerror = reject
    document.head.appendChild(s)
  })))
})

onUnmounted(() => {
  stopGame()
})
</script>

<template>
  <div class="jump-cat-page">
    <!-- 开始界面 -->
    <div v-if="!running" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.jumpCatView.title') }}</h1>
        <p>{{ t('message.jumpCatView.description') }}</p>
        <button class="start-btn" @click="startGame">{{ t('message.jumpCatView.startButton') }}</button>
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
        <button class="mario-btn" @click="goBack">&lt; {{ t('message.jumpCatView.back') }}</button>
        <div class="score-box">{{ t('message.jumpCatView.score') }}: {{ score }}</div>
        <div class="top-bar-right">
          <button class="mario-btn" :class="{ active: debugMode }" @click="toggleDebug">{{ t('message.jumpCatView.debug') }}</button>
          <button class="mario-btn danger" @click="stopGame">{{ t('message.jumpCatView.stop') }}</button>
        </div>
      </div>

      <div v-if="showCombo" class="combo-board" :key="combo">{{ t('message.jumpCatView.combo') }} x{{ combo }}</div>

      <div v-if="!calibrated" class="calibrate-hint">
        {{ t('message.jumpCatView.calibrating') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.jump-cat-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #1a1a2e;
}

.camera-video {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  object-fit: cover;
  transform: scaleX(-1);
  z-index: 1;
}

.layer-canvas {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  z-index: 2;
}
.game-layer { z-index: 3; }

.ui-layer {
  position: fixed;
  top: 80px; left: 0;
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
  box-shadow: 4px 4px 0 rgba(0,0,0,0.3);
  transition: transform 0.1s;
}
.mario-btn:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 rgba(0,0,0,0.3); }
.mario-btn:active { transform: translate(4px, 4px); box-shadow: none; }
.mario-btn.danger { background: #e63946; }
.mario-btn.active { background: #2a9d8f; }

.combo-board {
  position: fixed;
  top: 160px; left: 50%;
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
  0% { transform: translateX(-50%) scale(1.2); }
  100% { transform: translateX(-50%) scale(1); }
}

.calibrate-hint {
  position: fixed;
  bottom: 160px; left: 50%;
  transform: translateX(-50%);
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
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(-10px); }
}

.overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  z-index: 100;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.start-box { text-align: center; color: #000; }
.start-box h1 { font-size: 64px; margin-bottom: 10px; font-weight: 950; }
.start-box p { font-size: 18px; color: #666; margin-bottom: 30px; font-weight: 800; letter-spacing: 1px; }
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
  background: #e63946;
  transform: translate(6px, 6px);
  z-index: -1;
}
.start-btn:hover { transform: translate(2px, 2px); box-shadow: 4px 4px 0 #000; }

@media (max-width: 768px) {
  .start-box h1 { font-size: 40px; }
  .start-box p { font-size: 14px; }
  .start-btn { padding: 14px 32px; font-size: 16px; }
  .top-bar { padding: 8px 12px; }
  .score-box { font-size: 18px; }
  .mario-btn { padding: 6px 12px; font-size: 11px; }
  .combo-board { font-size: 20px; top: 150px; }
}
</style>
