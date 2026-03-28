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

// ---- 像素猫绘制常量（参考 HomeView） ----
const T = '' // transparent
const B = '#000'
const O = '#FF9933' // 橘猫主色
const D = '#CC7A00' // 暗橘色
const P = '#FFB6C1' // 粉色
const PX = 6 // 像素单位大小

// 像素猫背面数据（屁股 + 后腿 + 尾巴）
const catBackPixels = [
  [T,T,T,T,T,T,T,T,T,T,T,T,B,B,B,B,B,B,B,B,T,T,T,T,T,T,T,T,T,T,T,T],
  [T,T,T,T,T,T,T,B,B,B,B,B,D,O,O,O,O,O,O,O,D,B,B,B,B,T,T,T,T,T,T],
  [T,T,T,T,T,B,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B,B,T,T,T,T],
  [T,T,T,T,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B,T,T,T],
  [T,T,T,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B,T,T],
  [T,T,B,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,B,T],
  [T,T,B,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,B,T],
  [T,B,D,O,O,O,O,O,O,D,D,D,D,D,D,D,D,D,D,D,O,O,O,O,O,O,O,O,D,B],
  [T,B,O,O,O,O,O,D,D,O,D,O,D,O,D,O,D,O,D,O,D,D,O,O,O,O,O,O,O,B],
  [T,B,O,O,O,O,D,O,O,O,D,O,O,O,D,O,O,O,D,O,O,O,D,O,O,O,O,O,O,B],
  [T,B,O,O,O,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,O,O,O,O,B],
  [T,B,O,O,O,D,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,O,D,O,O,O,O,B],
  [T,B,O,O,D,O,O,O,T,T,T,T,T,T,T,T,T,T,T,T,T,O,O,O,O,D,O,O,O,B],
  [T,B,O,O,D,O,O,O,T,T,T,T,T,T,T,T,T,T,T,T,T,T,O,O,O,D,O,O,O,B],
  [T,T,B,D,O,O,O,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,O,O,D,O,O,B,T],
  [T,T,T,B,D,D,D,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,D,D,D,D,B,T,T],
  [T,T,T,T,B,B,B,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,B,B,B,T,T,T,T],
  [T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T,T],
]

// 使用 box-shadow 技术绘制像素猫
function pixelizeCatBack(scale = 1): string {
  const shadows: string[] = []
  const sPX = PX * scale
  for (let y = 0; y < catBackPixels.length; y++) {
    const row = catBackPixels[y]
    if (!row) continue
    for (let x = 0; x < row.length; x++) {
      const color = row[x]
      if (color && color !== T) {
        shadows.push(`${x * sPX}px ${y * sPX}px 0 0 ${color}`)
      }
    }
  }
  return shadows.join(',')
}

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
  getLaneX(lane: number, depth: number, cw: number): number {
    const roadData = this.getRoadAtDepth(depth, cw, window.innerHeight)
    const laneWidth = roadData.width / 2
    // 左车道中心在 -laneWidth/2，右车道中心在 +laneWidth/2
    return (lane === -1 ? -laneWidth * 0.25 : laneWidth * 0.25)
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

    // 绘制道路分段
    for (let i = this.segments; i >= 0; i--) {
      const depth1 = i / this.segments
      const depth2 = (i + 1) / this.segments
      const seg1 = this.getRoadAtDepth(depth1, cw, ch)
      const seg2 = this.getRoadAtDepth(depth2, cw, ch)

      // 条纹颜色
      const stripeIndex = Math.floor((i + this.scrollOffset / 4) % 4)
      const isLight = stripeIndex < 2
      const roadColor = isLight ? '#555555' : '#444444'
      const grassColor = isLight ? '#3a6b34' : '#2d5a27'

      // 草地分段
      ctx.fillStyle = grassColor
      ctx.fillRect(0, seg1.y, cw, seg2.y - seg1.y + 1)

      // 道路分段（梯形）
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

      // **双车道中线**（道路中央，区分左右车道）
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
      const laneX = road.getLaneX(lane, h.z, cw)
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
    this.updateScreenX(cw)
  },

  updateScreenX(cw: number) {
    // 根据当前车道计算屏幕X坐标（深度为1，即最近处）
    const laneX = road.getLaneX(this.lane, 1, cw)
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

  update(cw: number) {
    // 平滑切换车道
    const laneSpeed = 0.15
    if (this.lane !== this.targetLane) {
      const diff = this.targetLane - this.lane
      if (Math.abs(diff) < laneSpeed) {
        this.lane = this.targetLane
      } else {
        this.lane += Math.sign(diff) * laneSpeed
      }
      this.updateScreenX(cw)
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
      ctx.ellipse(cx, this.baseY + 20, 50 * shadowScale, 20 * shadowScale, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    // 绘制像素猫背面
    const catSize = 1.8  // 缩放系数
    const catWidth = 31 * PX * catSize  // 像素网格宽度
    const catHeight = 17 * PX * catSize // 像素网格高度

    // 创建像素猫的 box-shadow
    const pixelShadow = pixelizeCatBack(catSize)

    // 使用一个div元素来绘制（通过box-shadow）
    // 但在Canvas中，我们需要用另一种方式
    // 这里我们用 fillRect 逐个绘制像素
    const sPX = PX * catSize
    const offsetX = cx - (catWidth / 2)
    const offsetY = cy - (catHeight / 2)

    for (let y = 0; y < catBackPixels.length; y++) {
      const row = catBackPixels[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const color = row[x]
        if (color && color !== T) {
          ctx.fillStyle = color
          ctx.fillRect(offsetX + x * sPX, offsetY + y * sPX, sPX, sPX)
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

    // 判断倾斜方向（镜像：视频是镜像的，所以鼻子的左边是用户的右边）
    const leanLeft = avgRecent < this.baseline - this.leanThreshold
    const leanRight = avgRecent > this.baseline + this.leanThreshold

    if (leanLeft) return -1  // 向左倾斜（视频中的左边）
    if (leanRight) return 1  // 向右倾斜（视频中的右边）
    return 0  // 居中
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
  cat.update(w)
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

  // 检测车道切换（用鼻子的x坐标）
  if (nose) {
    const lane = laneDetector.detect(nose.x)
    if (lane !== 0) {
      cat.switchLane(lane)
    }
  }

  // 检测跳跃（用臀部的y坐标）
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
  cat.updateScreenX(w)
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
  <div class="hurdle-cat-page">
    <!-- 开始界面 -->
    <div v-if="!running" class="overlay">
      <div class="start-box">
        <h1>{{ t('message.hurdleCatView.title') }}</h1>
        <p>{{ t('message.hurdleCatView.description') }}</p>
        <div class="instructions">
          <div class="instruction-item">🦘 跳跃躲避双栏杆</div>
          <div class="instruction-item">↔️ 左右倾斜切换车道</div>
        </div>
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
