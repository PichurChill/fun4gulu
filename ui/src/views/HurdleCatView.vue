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
const controlMode = ref<'body' | 'hand'>('body')

// ---- DOM refs ----
const videoRef = ref<HTMLVideoElement | null>(null)
const poseCanvasRef = ref<HTMLCanvasElement | null>(null)
const gameCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---- Canvas contexts (non-reactive) ----
let poseCtx: CanvasRenderingContext2D | null = null
let gameCtx: CanvasRenderingContext2D | null = null

// ---- 像素猫绘制常量 ----
const T = ''           // transparent
const B = '#000'       // black (outline)
const O = '#FFB347'    // 橘猫主色
const D = '#CC7A00'    // 暗橘色
const P = '#FFD1DC'    // 粉色（内耳）
const PX = 4           // 像素单位大小

// 从背后看的橘猫像素图（19x17，耳朵+头+身体+尾巴+后腿）
const backCatPixels = [
  [T,T,T,T,B,T,T,T,T,T,T,T,T,T,B,T,T,T,T,T],
  [T,T,T,B,O,B,T,T,T,T,T,T,T,T,B,O,B,T,T,T],
  [T,T,T,B,P,B,T,T,T,T,T,T,T,T,B,P,B,T,T,T],
  [T,T,T,B,O,B,T,T,T,T,T,T,T,T,B,O,B,T,T,T],
  [T,T,B,O,O,O,B,T,T,T,T,T,B,O,O,O,B,T,T,T],
  [T,T,B,O,O,O,O,B,T,T,T,B,O,O,O,O,B,T,T,T],
  [T,T,B,D,O,O,O,O,B,T,T,B,O,O,O,D,B,T,T,T],
  [T,B,O,O,O,O,O,O,O,T,O,O,O,O,O,O,O,B,T,T],
  [T,B,O,O,O,O,O,O,O,T,O,O,O,O,O,O,O,B,T,T],
  [B,O,O,O,O,O,O,O,O,T,O,O,O,O,O,O,O,O,B,T],
  [B,O,D,O,O,O,O,O,O,T,O,O,O,O,O,O,D,O,B,T],
  [B,D,D,O,O,O,O,O,O,T,O,O,O,O,O,D,D,O,B,T],
  [T,B,D,D,O,O,O,O,O,T,O,O,O,O,O,D,B,T,T,T],
  [T,T,B,D,D,D,O,O,O,T,O,O,O,D,D,D,B,T,T,T],
  [T,T,T,B,B,B,D,D,D,T,D,D,D,B,B,B,T,T,T,T],
  [T,T,T,T,T,T,B,D,B,T,B,D,B,T,T,T,T,T,T,T],
  [T,T,T,T,T,T,T,B,B,T,B,B,T,T,T,T,T,T,T,T],
]

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

function playSwitchSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(600, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.1)
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.1)
  } catch {}
}

// ---- 伪3D道路系统（双车道）----
const road = {
  vanishingY: 0,
  roadTopY: 0,
  roadBottomY: 0,
  roadTopWidth: 0,
  roadBottomWidth: 0,
  scrollOffset: 0,
  segments: 20,

  init(cw: number, ch: number) {
    this.vanishingY = ch * 0.3
    this.roadTopY = this.vanishingY
    this.roadBottomY = ch * 0.92
    this.roadTopWidth = cw * 0.02
    this.roadBottomWidth = cw * 0.7
    this.scrollOffset = 0
  },

  getRoadAtDepth(depth: number, cw: number, ch: number): { y: number; width: number; scale: number } {
    const t = depth
    const y = this.roadTopY + (this.roadBottomY - this.roadTopY) * t * t
    const width = this.roadTopWidth + (this.roadBottomWidth - this.roadTopWidth) * t
    const scale = 0.1 + t * 0.9
    return { y, width, scale }
  },

  // 获取车道位置（-1=左车道，1=右车道）
  getLaneX(lane: number, depth: number, cw: number, ch: number): number {
    const roadData = this.getRoadAtDepth(depth, cw, ch)
    const laneWidth = roadData.width / 2
    // 左车道中心在 -laneWidth/2，右车道中心在 +laneWidth/2
    return (lane === -1 ? -laneWidth * 0.5 : laneWidth * 0.5)
  },

  update() {
    // 速度减慢到原来的 40-50%（从 8 改为 3.2）
    this.scrollOffset = (this.scrollOffset + 3.2) % 64
  },

  draw(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    // 天空渐变
    const skyGradient = ctx.createLinearGradient(0, 0, 0, this.vanishingY)
    skyGradient.addColorStop(0, '#1a1a40')
    skyGradient.addColorStop(1, '#4a4a80')
    ctx.fillStyle = skyGradient
    ctx.fillRect(0, 0, cw, this.vanishingY)

    // 地面（草地）
    ctx.fillStyle = '#2d5a27'
    ctx.fillRect(0, this.vanishingY, cw, ch - this.vanishingY)

    // 绘制道路分段（草地条纹+道路+边线+车道线）
    for (let i = this.segments; i >= 0; i--) {
      const depth1 = i / this.segments
      const depth2 = (i + 1) / this.segments
      const seg1 = this.getRoadAtDepth(depth1, cw, ch)
      const seg2 = this.getRoadAtDepth(depth2, cw, ch)

      // 条纹颜色
      const stripeIndex = Math.floor((i + this.scrollOffset / 4) % 4)
      const isLight = stripeIndex < 2
      const grassColor = isLight ? '#3a6b34' : '#2d5a27'
      const roadColor = '#555555'

      // 草地分段（仅道路两侧）
      ctx.fillStyle = grassColor
      ctx.beginPath()
      ctx.moveTo(0, seg2.y)
      ctx.lineTo(0, seg1.y)
      ctx.lineTo(cw / 2 - seg1.width / 2, seg1.y)
      ctx.lineTo(cw / 2 - seg2.width / 2, seg2.y)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(cw, seg2.y)
      ctx.lineTo(cw, seg1.y)
      ctx.lineTo(cw / 2 + seg1.width / 2, seg1.y)
      ctx.lineTo(cw / 2 + seg2.width / 2, seg2.y)
      ctx.closePath()
      ctx.fill()

      // 道路分段（梯形，逐段填充）
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

      // 双车道中线（虚线）
      if (stripeIndex % 2 === 0) {
        ctx.strokeStyle = '#ffffff'
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

// ---- 栏杆系统（双车道）----
interface Hurdle {
  z: number
  lane: -1 | 1 | 0  // -1=左车道，1=右车道，0=双车道都有
  hit: boolean
  rotation: number
  vx: number
  vy: number
  alpha: number
}

const hurdles: Hurdle[] = []
const hurdleSpawnTimer = ref(0)
const HURDLE_SPAWN_INTERVAL = 200  // 增加间隔，因为速度变慢了

function spawnHurdle() {
  // 90% 概率单车道，10% 概率双车道
  const isDoubleLane = Math.random() < 0.1
  const lane = isDoubleLane ? 0 : (Math.random() < 0.5 ? -1 : 1)

  hurdles.push({
    z: 0,  // 从最远处开始
    lane,
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
      h.vx *= 1.05
      h.z += 0.02
      h.rotation += h.vx * 0.5
      h.alpha -= 0.02

      if (h.alpha <= 0 || h.z > 1.5) {
        hurdles.splice(i, 1)
      }
      continue
    }

    // **速度减慢到 40-50%**（从 0.012 改为 0.005）
    h.z += 0.005

    // 碰撞检测：当栏杆到达猫的位置
    if (h.z > 0.92 && h.z < 0.98) {
      // 检查猫是否在栏杆所在的车道
      const catInLeftLane = cat.lane < 0
      const catInRightLane = cat.lane > 0

      const hitLeft = (h.lane === -1 || h.lane === 0) && catInLeftLane
      const hitRight = (h.lane === 1 || h.lane === 0) && catInRightLane
      const willHit = hitLeft || hitRight

      if (willHit && jumpHeight < 0.4) {
        // 撞到栏杆
        h.hit = true
        h.vx = h.lane < 0 ? 0.03 : -0.03
        score.value = Math.max(0, score.value - 1)
        combo.value = 0
        showCombo.value = false
        spawnFloatingText(window.innerWidth / 2, cat.y - 60, '-1', '#e63946')
        playHitSound()
        shakeScreen()
        spawnParticles(cat.screenX, cat.y)
      } else if (willHit || (!willHit && h.lane !== 0)) {
        // 成功躲避（跳跃或切换车道）
        score.value++
        combo.value++
        if (combo.value > 1) showCombo.value = true
        if (comboTimer) clearTimeout(comboTimer)
        comboTimer = setTimeout(() => { combo.value = 0; showCombo.value = false }, 2000)
        spawnFloatingText(window.innerWidth / 2, cat.y - 100, combo.value > 1 ? `x${combo.value}` : '+1', '#FFD700')
        playJumpSound()
        hurdles.splice(i, 1)
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

    // 如果是双车道栏杆，画两个
    const lanesToDraw = h.lane === 0 ? [-1, 1] : [h.lane]

    for (const lane of lanesToDraw) {
      const laneX = road.getLaneX(lane, h.z, cw, ch)
      const hurdleX = cw / 2 + laneX
      const hurdleY = roadData.y
      const scale = roadData.scale

      ctx.save()
      ctx.globalAlpha = h.alpha

      if (h.hit) {
        // 被撞飞的栏杆
        ctx.translate(hurdleX, hurdleY)
        ctx.rotate(h.rotation)
        drawHurdleSprite(ctx, 0, 0, scale * 100, scale * 50, true)
      } else {
        // 正常栏杆
        ctx.translate(hurdleX, hurdleY)
        drawHurdleSprite(ctx, 0, 0, scale * 100, scale * 50, false)
      }

      ctx.restore()
    }
  }
}

function drawHurdleSprite(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, isHit: boolean) {
  const pipeColor = isHit ? '#888888' : '#cc3333'
  const capColor = isHit ? '#666666' : '#eeeeee'

  // 左支柱
  ctx.fillStyle = pipeColor
  ctx.fillRect(x - w * 0.35, y, w * 0.08, h)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = Math.max(1, w * 0.02)
  ctx.strokeRect(x - w * 0.35, y, w * 0.08, h)

  // 右支柱
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

// ---- 猫咪（像素风格背面，双车道）----
const cat = {
  lane: -1,           // -1=左车道，1=右车道
  targetLane: -1,     // 目标车道
  x: 0,               // 屏幕X坐标
  y: 0,
  baseY: 0,
  vy: 0,
  gravity: 0.9,
  jumpForce: -20,
  jumpHeight: 150,
  isJumping: false,
  tailWag: 0,
  screenX: 0,         // 实际屏幕坐标

  reset(cw: number, ch: number) {
    this.baseY = ch * 0.78
    this.lane = -1
    this.targetLane = -1
    this.x = cw / 2
    this.y = this.baseY
    this.vy = 0
    this.isJumping = false
    this.updateScreenX(cw, ch)
  },

  updateScreenX(cw: number, ch: number) {
    // 根据当前车道计算屏幕X坐标（深度为1，即最近处）
    const laneX = road.getLaneX(this.lane, 1, cw, ch)
    this.screenX = cw / 2 + laneX
    this.x = this.screenX
  },

  switchLane(dir: -1 | 1) {
    if (this.targetLane !== dir) {
      this.targetLane = dir
      playSwitchSound()
      // 生成切换特效
      spawnFloatingText(this.x, this.y - 80, dir < 0 ? '◀' : '▶', '#4a90e2')
    }
  },

  jump() {
    if (this.isJumping) return
    this.vy = this.jumpForce
    this.isJumping = true
    playJumpSound()
  },

  update(cw: number, ch: number) {
    // 平滑切换车道
    const laneSpeed = 0.15
    if (this.lane !== this.targetLane) {
      const diff = this.targetLane - this.lane
      if (Math.abs(diff) < laneSpeed) {
        this.lane = this.targetLane
      } else {
        this.lane += Math.sign(diff) * laneSpeed
      }
      this.updateScreenX(cw, ch)
    }

    // 跳跃物理
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
    const cx = this.x
    const cy = this.y

    ctx.save()

    // 跳跃时的阴影
    if (this.isJumping) {
      const shadowScale = 1 - (this.baseY - this.y) / this.jumpHeight * 0.3
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.beginPath()
      ctx.ellipse(cx, this.baseY + 20, 40 * shadowScale, 15 * shadowScale, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    // 绘制像素猫（60% 大小）
    const scale = 0.6
    const pixelSize = PX * scale

    // 计算像素图的总尺寸
    const catWidth = backCatPixels[0]!.length * pixelSize
    const catHeight = backCatPixels.length * pixelSize

    // 居中偏移
    const startX = cx - catWidth / 2
    const startY = cy - catHeight / 2 - 20 * scale  // 稍微向上偏移

    // 逐个像素绘制
    for (let y = 0; y < backCatPixels.length; y++) {
      for (let x = 0; x < backCatPixels[y]!.length; x++) {
        const color = backCatPixels[y]![x]
        if (color && color !== T) {
          ctx.fillStyle = color
          ctx.fillRect(
            startX + x * pixelSize,
            startY + y * pixelSize,
            pixelSize,
            pixelSize
          )
        }
      }
    }

    ctx.restore()
  }
}

// ---- 车道切换检测（左右摆动）----
const laneDetector = {
  history: [] as number[],
  maxHistory: 20,
  baseline: null as number | null,
  baselineSamples: [] as number[],
  leanThreshold: 0.08,  // 身体倾斜阈值

  reset() {
    this.history = []
    this.baseline = null
    this.baselineSamples = []
    calibrated.value = false
  },

  detect(noseX: number): -1 | 0 | 1 {
    if (!noseX || noseX <= 0 || noseX >= 1) return 0

    // 收集基准线样本
    if (!this.baseline) {
      this.baselineSamples.push(noseX)
      if (this.baselineSamples.length >= 15) {
        const sorted = [...this.baselineSamples].sort((a, b) => a - b)
        this.baseline = sorted[Math.floor(sorted.length / 2)] ?? null
        calibrated.value = true
      }
      return 0
    }

    // 记录历史
    this.history.push(noseX)
    if (this.history.length > this.maxHistory) this.history.shift()

    // 计算最近的平均位置
    if (this.history.length < 10) return 0
    const recent = this.history.slice(-8)
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length

    // 判断倾斜方向
    const leanLeft = avgRecent < this.baseline - this.leanThreshold
    const leanRight = avgRecent > this.baseline + this.leanThreshold

    if (leanLeft) return 1   // noseX小=画面中往右
    if (leanRight) return -1  // noseX大=画面中往左
    return 0  // 居中
  }
}

// ---- 手部模式检测器 ----
const handModeDetector = {
  // 车道检测（检测左右手腕高度）
  wristHistory: [] as { leftY: number; rightY: number; timestamp: number }[],
  maxHistory: 15,
  wristBaseline: null as { leftY: number; rightY: number } | null,
  baselineSamples: [] as { leftY: number; rightY: number }[],
  heightThreshold: 0.08,  // 抬手高度阈值
  lastLaneSwitchTime: 0,
  laneSwitchCooldown: 300,  // 防抖冷却时间

  // 跳跃检测（检测任一只手超过肩膀）
  jumpHistory: [] as number[],
  jumpMaxHistory: 10,
  shoulderBaseline: null as { leftY: number; rightY: number } | null,
  shoulderBaselineSamples: [] as { leftY: number; rightY: number }[],
  lastJumpTime: 0,
  jumpCooldown: 400,

  reset() {
    this.wristHistory = []
    this.wristBaseline = null
    this.baselineSamples = []
    this.jumpHistory = []
    this.shoulderBaseline = null
    this.shoulderBaselineSamples = []
    this.lastJumpTime = 0
    this.lastLaneSwitchTime = 0
    calibrated.value = false
  },

  // 检测车道切换（检测哪只手抬得更高）
  detectLane(leftWristY: number, rightWristY: number): -1 | 0 | 1 {
    if (!leftWristY || leftWristY <= 0 || leftWristY >= 1 ||
        !rightWristY || rightWristY <= 0 || rightWristY >= 1) return 0

    // 收集基准线样本（站立时手腕位置）
    if (!this.wristBaseline) {
      this.baselineSamples.push({ leftY: leftWristY, rightY: rightWristY })
      if (this.baselineSamples.length >= 15) {
        // 取中位数作为基准
        const sortedLeft = [...this.baselineSamples].sort((a, b) => a.leftY - b.leftY)
        const sortedRight = [...this.baselineSamples].sort((a, b) => a.rightY - b.rightY)
        this.wristBaseline = {
          leftY: sortedLeft[Math.floor(sortedLeft.length / 2)]!.leftY,
          rightY: sortedRight[Math.floor(sortedRight.length / 2)]!.rightY
        }
        calibrated.value = true
      }
      return 0
    }

    // 记录历史
    this.wristHistory.push({
      leftY: leftWristY,
      rightY: rightWristY,
      timestamp: Date.now()
    })
    if (this.wristHistory.length > this.maxHistory) this.wristHistory.shift()

    // 计算最近的平均位置
    if (this.wristHistory.length < 10) return 0
    const recent = this.wristHistory.slice(-6)

    // 检查冷却时间
    const now = Date.now()
    if (now - this.lastLaneSwitchTime < this.laneSwitchCooldown) return 0

    const avgLeft = recent.reduce((sum, h) => sum + h.leftY, 0) / recent.length
    const avgRight = recent.reduce((sum, h) => sum + h.rightY, 0) / recent.length

    // 计算相对于基准的抬手高度（y值越小表示越高）
    const leftLift = this.wristBaseline.leftY - avgLeft
    const rightLift = this.wristBaseline.rightY - avgRight

    // 判断哪只手抬得更高
    // 注意：MediaPipe Pose 中，landmark 15 是图像左侧=用户右手，landmark 16 是图像右侧=用户左手
    // 所以这里需要镜像判断
    if (leftLift > this.heightThreshold && leftLift > rightLift + 0.03) {
      // 左手腕抬得高（图像左侧=用户右手）→ 切换到右车道
      this.lastLaneSwitchTime = now
      return 1
    }
    if (rightLift > this.heightThreshold && rightLift > leftLift + 0.03) {
      // 右手腕抬得高（图像右侧=用户左手）→ 切换到左车道
      this.lastLaneSwitchTime = now
      return -1
    }

    return 0
  },

  // 检测跳跃（检测任一只手超过肩膀）
  detectJump(leftWristY: number, rightWristY: number, leftShoulderY: number, rightShoulderY: number): boolean {
    if (!leftWristY || !rightWristY || !leftShoulderY || !rightShoulderY) return false

    // 收集肩膀基准
    if (!this.shoulderBaseline) {
      this.shoulderBaselineSamples.push({ leftY: leftShoulderY, rightY: rightShoulderY })
      if (this.shoulderBaselineSamples.length >= 10) {
        const sortedLeft = [...this.shoulderBaselineSamples].sort((a, b) => a.leftY - b.leftY)
        const sortedRight = [...this.shoulderBaselineSamples].sort((a, b) => a.rightY - b.rightY)
        this.shoulderBaseline = {
          leftY: sortedLeft[Math.floor(sortedLeft.length / 2)]!.leftY,
          rightY: sortedRight[Math.floor(sortedRight.length / 2)]!.rightY
        }
      }
      return false
    }

    // 检查冷却时间
    const now = Date.now()
    if (now - this.lastJumpTime < this.jumpCooldown) return false

    // 检查任一只手是否超过对应肩膀（y值更小=更高）
    const leftHandAbove = leftWristY < this.shoulderBaseline.leftY - 0.05
    const rightHandAbove = rightWristY < this.shoulderBaseline.rightY - 0.05

    if (leftHandAbove || rightHandAbove) {
      this.lastJumpTime = now
      return true
    }

    return false
  }
}

// ---- 跳跃检测（保持原有逻辑）----
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

// ---- 粒子 ----
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }
const particles: Particle[] = []
function spawnParticles(x: number, y: number) {
  const colors = ['#FF9933', '#FFB6C1', '#FF6B6B', '#FFF', '#FFD700']
  for (let i = 0; i < 12; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 10,
      vy: -Math.random() * 8 - 2,
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
  cat.update(w, h)
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

function onPoseResults(results: any) {
  if (!poseCtx || !poseCanvasRef.value) return
  poseCtx.clearRect(0, 0, poseCanvasRef.value.width, poseCanvasRef.value.height)
  if (!results.poseLandmarks) return

  if (debugMode.value) {
    poseCtx.save()
    poseCtx.translate(poseCanvasRef.value.width, 0)
    poseCtx.scale(-1, 1)
    ;(window as any).drawConnectors(poseCtx, results.poseLandmarks, (window as any).POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 2 })
    ;(window as any).drawLandmarks(poseCtx, results.poseLandmarks, { color: '#FF0000', lineWidth: 1, radius: 3 })
    poseCtx.restore()
  }

  if (!running.value) return

  const nose = results.poseLandmarks[0]
  const leftHip = results.poseLandmarks[23]
  const rightHip = results.poseLandmarks[24]
  const leftWrist = results.poseLandmarks[15]
  const rightWrist = results.poseLandmarks[16]
  const leftShoulder = results.poseLandmarks[11]
  const rightShoulder = results.poseLandmarks[12]

  // 根据控制模式使用不同的检测逻辑
  if (controlMode.value === 'body') {
    // 身体模式：用鼻子检测车道切换，用臀部检测跳跃
    if (nose) {
      const lane = laneDetector.detect(nose.x)
      if (lane !== 0) {
        cat.switchLane(lane)
      }
    }

    if (leftHip && rightHip) {
      const hipY = (leftHip.y + rightHip.y) / 2
      if (jumpDetector.detect(hipY)) cat.jump()
    }
  } else {
    // 手部模式：用手腕检测车道切换和跳跃
    if (leftWrist && rightWrist) {
      const lane = handModeDetector.detectLane(leftWrist.y, rightWrist.y)
      if (lane !== 0) {
        cat.switchLane(lane)
      }
    }

    if (leftWrist && rightWrist && leftShoulder && rightShoulder) {
      if (handModeDetector.detectJump(leftWrist.y, rightWrist.y, leftShoulder.y, rightShoulder.y)) {
        cat.jump()
      }
    }
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
  cat.updateScreenX(w, h)
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
    laneDetector.reset()
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

function toggleControlMode() {
  const oldMode = controlMode.value
  controlMode.value = controlMode.value === 'body' ? 'hand' : 'body'

  // 切换模式时重置检测器状态
  if (oldMode === 'body') {
    laneDetector.reset()
    jumpDetector.reset()
  } else {
    handModeDetector.reset()
  }
}

function goBack() {
  stopGame()
  router.back()
}

onMounted(() => {
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
  <div class="hurdle-cat-page" :class="{ 'debug-overlay': debugMode }">
    <!-- 开始界面 -->
    <div v-if="!running" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.hurdleCatView.title') }}</h1>
        <p>{{ t('message.hurdleCatView.description') }}</p>
        <div class="mode-selector">
          <button class="mode-option" :class="{ active: controlMode === 'body' }" @click="controlMode = 'body'">
            {{ t('message.hurdleCatView.bodyMode') }}
          </button>
          <button class="mode-option" :class="{ active: controlMode === 'hand' }" @click="controlMode = 'hand'">
            {{ t('message.hurdleCatView.handMode') }}
          </button>
        </div>
        <div class="instructions">
          <div class="instruction-item">
            {{ controlMode === 'body' ? t('message.hurdleCatView.instructionsBody') : t('message.hurdleCatView.instructionsHand') }}
          </div>
        </div>
        <button class="start-btn" @click="startGame">{{ t('message.hurdleCatView.startButton') }}</button>
      </div>
    </div>

    <!-- 摄像头 -->
    <video ref="videoRef" autoplay playsinline class="camera-video" />

    <!-- 骨架层 -->
    <canvas ref="poseCanvasRef" class="layer-canvas pose-canvas-layer" />

    <!-- 游戏层 -->
    <canvas ref="gameCanvasRef" class="layer-canvas game-layer" />

    <!-- UI 层 -->
    <div v-if="running" class="ui-layer">
      <!-- 顶部工具栏 -->
      <div class="top-bar">
        <button class="mario-btn" @click="goBack">&lt; {{ t('message.hurdleCatView.back') }}</button>
        <div class="score-box">{{ t('message.hurdleCatView.score') }}: {{ score }}</div>
        <button class="mario-btn mode-btn" @click="toggleControlMode">
          {{ t('message.hurdleCatView.controlMode') }}: {{ controlMode === 'body' ? t('message.hurdleCatView.bodyMode') : t('message.hurdleCatView.handMode') }}
        </button>
        <div class="top-bar-right">
          <button class="mario-btn" :class="{ active: debugMode }" @click="toggleDebug">{{ t('message.hurdleCatView.debug') }}</button>
          <button class="mario-btn danger" @click="stopGame">{{ t('message.hurdleCatView.stop') }}</button>
        </div>
      </div>

      <div v-if="showCombo" class="combo-board" :key="combo">{{ t('message.hurdleCatView.combo') }} x{{ combo }}</div>

      <div v-if="!calibrated" class="calibrate-hint">
        {{ t('message.hurdleCatView.calibrating') }}
      </div>

      <!-- 车道指示器 -->
      <div class="lane-indicator">
        <div class="lane-dot" :class="{ active: cat.lane < 0 }"></div>
        <div class="lane-divider"></div>
        <div class="lane-dot" :class="{ active: cat.lane > 0 }"></div>
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

/* 调试模式下骨架层显示在最上面 */
.debug-overlay .pose-canvas-layer {
  z-index: 4 !important;
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
  gap: 10px;
  flex-wrap: wrap;
}
.top-bar > * {
  flex-shrink: 0;
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

.mode-btn {
  background: #4a90e2;
}

/* 模式选择器 */
.mode-selector {
  display: flex;
  gap: 15px;
  justify-content: center;
  margin-bottom: 20px;
}

.mode-option {
  background: #fff;
  color: #000;
  border: 3px solid #000;
  box-shadow: 4px 4px 0 #000;
  padding: 10px 25px;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-option:hover {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 #000;
}

.mode-option.active {
  background: #000;
  color: #fff;
  transform: translate(4px, 4px);
  box-shadow: none;
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

/* 车道指示器 */
.lane-indicator {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 20px;
  background: #fff;
  border: 4px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 10px 20px;
  pointer-events: none;
}

.lane-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ccc;
  border: 3px solid #000;
  transition: all 0.2s;
}

.lane-dot.active {
  background: #FF9933;
  transform: scale(1.3);
}

.lane-divider {
  width: 30px;
  height: 4px;
  background: #000;
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
  margin-bottom: 20px;
  font-weight: 800;
  letter-spacing: 1px;
}

.instructions {
  display: flex;
  gap: 20px;
  justify-content: center;
  margin-bottom: 30px;
}

.instruction-item {
  background: #fff;
  border: 3px solid #000;
  box-shadow: 4px 4px 0 #000;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 900;
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

  .mode-selector {
    flex-direction: row;
    gap: 10px;
  }

  .mode-option {
    font-size: 12px;
    padding: 8px 16px;
  }

  .instructions {
    flex-direction: column;
    gap: 10px;
  }

  .instruction-item {
    font-size: 12px;
    padding: 8px 16px;
  }

  .start-btn {
    padding: 14px 32px;
    font-size: 16px;
  }

  .top-bar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
  }

  .score-box {
    font-size: 18px;
  }

  .mario-btn {
    padding: 6px 12px;
    font-size: 11px;
  }

  .mode-btn {
    font-size: 10px;
    padding: 5px 10px;
  }

  .combo-board {
    font-size: 20px;
    top: 150px;
  }

  .lane-indicator {
    bottom: 20px;
    padding: 8px 16px;
  }

  .lane-dot {
    width: 16px;
    height: 16px;
  }

  .lane-divider {
    width: 24px;
  }
}
</style>
