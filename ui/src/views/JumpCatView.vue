<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

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
    particles.push({ x, y, vx: (Math.random() - 0.5) * 6, vy: -Math.random() * 4 - 2, life: 1, color: colors[Math.floor(Math.random() * colors.length)], size: Math.random() * 6 + 3 })
  }
}
function updateAndDrawParticles(ctx: CanvasRenderingContext2D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
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
    const t = floatingTexts[i]
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
  jumpCooldown: 600,
  reset() {
    this.history = []; this.baseline = null; this.baselineSamples = []; this.jumping = false; this.lastJumpTime = 0
    calibrated.value = false
  },
  detect(hipY: number): boolean {
    if (!hipY || hipY <= 0 || hipY >= 1) return false
    if (!this.baseline) {
      this.baselineSamples.push(hipY)
      if (this.baselineSamples.length >= 30) {
        const sorted = [...this.baselineSamples].sort((a, b) => a - b)
        this.baseline = sorted[Math.floor(sorted.length / 2)]
        calibrated.value = true
      }
      return false
    }
    this.history.push(hipY)
    if (this.history.length > this.maxHistory) this.history.shift()
    if (this.history.length < 8) return false
    const threshold = 0.04
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
  score.value++
  combo.value++
  if (combo.value > 1) {
    showCombo.value = true
    // trigger reflow for animation
  }
  if (comboTimer) clearTimeout(comboTimer)
  comboTimer = setTimeout(() => { combo.value = 0; showCombo.value = false }, 2000)
  cat.jump()
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
  cat.baseY = h - 150
  cat.x = w / 2
  if (!cat.isJumping) cat.y = cat.baseY
}

// ---- 游戏流程 ----
async function startGame() {
  if (!videoRef.value) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
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
      width: 640, height: 480,
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
        <h1>🐱 跳跳猫</h1>
        <p>站在摄像头前，跳跃得分！</p>
        <button class="start-btn" @click="startGame">🎮 开始游戏</button>
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
      <div class="score-board">🎯 分数: {{ score }}</div>
      <div v-if="showCombo" class="combo-board" :key="combo">🔥 连击 x{{ combo }}</div>

      <div v-if="!calibrated" class="calibrate-hint">
        👤 请站在画面中间，校准中...
      </div>

      <div class="controls">
        <button class="ctrl-btn" :class="{ active: debugMode }" @click="toggleDebug">🔍 调试</button>
        <button class="ctrl-btn" @click="stopGame">⏹ 结束</button>
        <button class="ctrl-btn" @click="goBack">← 返回</button>
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
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  z-index: 10;
  pointer-events: none;
}
.ui-layer .controls {
  pointer-events: auto;
}

.score-board {
  position: absolute;
  top: 20px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(10px);
  color: #fff;
  font-size: 28px;
  font-weight: bold;
  padding: 10px 30px;
  border-radius: 50px;
  border: 2px solid rgba(255,255,255,0.2);
}

.combo-board {
  position: absolute;
  top: 80px; left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, #ff6b6b, #ee5a24);
  color: #fff;
  font-size: 22px;
  font-weight: bold;
  padding: 6px 24px;
  border-radius: 30px;
  animation: comboPulse 0.3s ease;
}
@keyframes comboPulse {
  0% { transform: translateX(-50%) scale(1.3); }
  100% { transform: translateX(-50%) scale(1); }
}

.calibrate-hint {
  position: absolute;
  bottom: 100px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(10px);
  color: #fff;
  padding: 12px 28px;
  border-radius: 30px;
  font-size: 18px;
  animation: hintBounce 1.5s ease infinite;
}
@keyframes hintBounce {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(-10px); }
}

.controls {
  position: absolute;
  bottom: 30px; right: 30px;
  display: flex; gap: 10px;
}
.ctrl-btn {
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(10px);
  color: #fff;
  border: 2px solid rgba(255,255,255,0.2);
  border-radius: 12px;
  padding: 8px 16px;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s;
}
.ctrl-btn:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.5); }
.ctrl-btn.active { border-color: #00FF00; }

.overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  z-index: 100;
  background: rgba(26, 26, 46, 0.92);
  backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.start-box { text-align: center; color: #fff; }
.start-box h1 { font-size: 64px; margin-bottom: 10px; }
.start-box p { font-size: 20px; color: rgba(255,255,255,0.7); margin-bottom: 30px; }
.start-btn {
  background: linear-gradient(135deg, #ff9a9e, #fad0c4);
  color: #333;
  border: none;
  padding: 16px 48px;
  font-size: 24px;
  font-weight: bold;
  border-radius: 50px;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}
.start-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 8px 30px rgba(255, 154, 158, 0.4);
}

@media (max-width: 768px) {
  .start-box h1 { font-size: 40px; }
  .start-box p { font-size: 16px; }
  .start-btn { padding: 12px 32px; font-size: 18px; }
  .score-board { font-size: 20px; padding: 8px 20px; }
}
</style>
