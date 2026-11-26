import type { GestureSnapshot, LiveBodyPose, PoseLandmark, Vec3Like } from './types'

interface Vec3 {
  x: number
  y: number
  z: number
  v: number
}

interface DiscArmedState {
  time: number
  relX: number
  relY: number
  relZ: number
}

interface MotionSample {
  t: number
  x2: number
  y2: number
  x3: number
  y3: number
  z3: number
}

/** 单臂一阶速度 + 二阶爆发加速度与有效击打行程动力学状态 */
interface WristKinematics {
  prev2: { x: number; y: number } | null
  prev3: { x: number; y: number; z: number } | null
  prevElbowDeg: number | null
  prevRadial2D: number | null
  // 一阶平滑速度（单位：肩宽/秒；角速度单位：度/秒）
  vx2: number
  vy2: number
  speed2D: number
  forwardVel3D: number
  speed3D: number
  elbowVel: number
  radialVel2D: number
  // 140ms 短窗内捕获的二阶正向爆发加速度峰值（单位：肩宽/秒²）
  peakAccel2D: number
  peakAccel2DAt: number
  peakUpAccel: number
  peakUpAccelAt: number
  peakFwdAccel: number
  peakFwdAccelAt: number
  peakSpeed3DAccel: number
  peakSpeed3DAccelAt: number
  peakElbowAccel: number
  peakElbowAccelAt: number
  // 近 160ms 轨迹点缓存，用于计算有效出拳行程，过滤原地抖动
  trail: MotionSample[]
}

/** 单腿飞踢上提速度与爆发加速度状态 */
interface KickKinematics {
  prevAnkleRelY: number | null
  prevKneeRelY: number | null
  upVel: number
  peakUpAccel: number
  peakUpAccelAt: number
  wasHigh: boolean
}

function createWristKinematics(): WristKinematics {
  return {
    prev2: null,
    prev3: null,
    prevElbowDeg: null,
    prevRadial2D: null,
    vx2: 0,
    vy2: 0,
    speed2D: 0,
    forwardVel3D: 0,
    speed3D: 0,
    elbowVel: 0,
    radialVel2D: 0,
    peakAccel2D: 0,
    peakAccel2DAt: -Infinity,
    peakUpAccel: 0,
    peakUpAccelAt: -Infinity,
    peakFwdAccel: 0,
    peakFwdAccelAt: -Infinity,
    peakSpeed3DAccel: 0,
    peakSpeed3DAccelAt: -Infinity,
    peakElbowAccel: 0,
    peakElbowAccelAt: -Infinity,
    trail: [],
  }
}

function createKickKinematics(): KickKinematics {
  return {
    prevAnkleRelY: null,
    prevKneeRelY: null,
    upVel: 0,
    peakUpAccel: 0,
    peakUpAccelAt: -Infinity,
    wasHigh: false,
  }
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const dist2D = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y)

function isVisible(p: Vec3 | undefined, threshold = 0.35): p is Vec3 {
  return !!p && p.v > threshold && Number.isFinite(p.x) && Number.isFinite(p.y)
}

function elbowAngleDeg(s: Vec3, e: Vec3, w: Vec3): number {
  const ax = s.x - e.x
  const ay = s.y - e.y
  const az = s.z - e.z
  const bx = w.x - e.x
  const by = w.y - e.y
  const bz = w.z - e.z
  const denom = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)
  if (denom < 1e-6) return 0
  const cos = clamp((ax * bx + ay * by + az * bz) / denom, -1, 1)
  return (Math.acos(cos) * 180) / Math.PI
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t = lenSq > 1e-6 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1) : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

function segmentsCross(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  // 包围盒快速排斥：防止双臂水平一字共线（如标准 T 字展臂）时叉积为 0 被误判为交叉
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  ) {
    return false
  }
  const cross = (p: Vec3, q: Vec3, r: Vec3) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0
}

function mpDirToWorld(from: Vec3, to: Vec3, zScale = 0.92): Vec3Like | null {
  const x = -(to.x - from.x)
  const y = -(to.y - from.y)
  const z = (to.z - from.z) * zScale
  const len = Math.hypot(x, y, z)
  if (len < 1e-4) return null
  return { x: x / len, y: y / len, z: z / len }
}

function avgVec(a: Vec3, b: Vec3): Vec3 {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    v: Math.min(a.v, b.v),
  }
}

class SmoothHold {
  private readonly graceMs: number
  private elapsed = 0
  private lastTick = -Infinity
  private lastActive = -Infinity

  constructor(graceMs = 200) {
    this.graceMs = graceMs
  }

  public update(active: boolean, now: number): number {
    const dt = Number.isFinite(this.lastTick) ? clamp(now - this.lastTick, 0, 120) : 0
    this.lastTick = now
    if (active) {
      this.elapsed += dt
      this.lastActive = now
    } else if (now - this.lastActive > this.graceMs) {
      this.elapsed = 0
    }
    return this.elapsed
  }

  public isRecent(now: number): boolean {
    return now - this.lastActive <= this.graceMs
  }

  public reset() {
    this.elapsed = 0
    this.lastTick = -Infinity
    this.lastActive = -Infinity
  }
}

/**
 * 物理动力学驱动的全向奥特曼体感识别引擎：
 * 1) 基于肩宽归一化的一阶平滑速度 + 二阶正向脉冲加速度 + 有效击打行程四重门控：
 *    正常慢速/常速抬手与摆臂只 1:1 驱动奥特曼骨骼跟随摆动，绝不误触发攻击；
 *    唯有具备明显爆发加速度与击打速度的真实发力出拳/飞踢/挥劈才触发攻击判定，并过滤收拳回拉二次误触。
 * 2) 高灵敏度横向走位识别（融合双肩与骨盆中心），远程火球大步闪避跟手流畅。
 * 3) 兼容横屏与手机竖屏的举手变身、双臂展翼蓄力、胸前 X 护盾与 L/十字必杀光线识别。
 */
export class UltraGestureRecognizer {
  private centerOffset = 0
  private lastMidXRatio = 0.5
  private baseShoulderY: number | null = null
  private prevMidY: number | null = null
  private prevLean = 0
  private lastFrameTime: number | null = null
  private guardSince: number | null = null
  private prevGuardActive = false

  private beamHold = new SmoothHold(240)
  private beamFired = false
  private spreadHold = new SmoothHold(220)
  private transformHold = new SmoothHold(240)
  private transformFired = false
  private typeHold = new SmoothHold(240)
  private typeFired = false

  private discRaiseStart: [number | null, number | null] = [null, null]
  private discArmed: [DiscArmedState | null, DiscArmedState | null] = [null, null]

  // 左右独立运动学追踪器（速度 + 加速度峰值 + 轨迹行程）
  private wristKin: [WristKinematics, WristKinematics] = [
    createWristKinematics(),
    createWristKinematics(),
  ]
  private punchLast: [number, number] = [-Infinity, -Infinity]
  private punchPeakLock: [boolean, boolean] = [false, false]

  private kickLast: [number, number] = [-Infinity, -Infinity]
  private kickKin: [KickKinematics, KickKinematics] = [
    createKickKinematics(),
    createKickKinematics(),
  ]
  private smoothLean = 0
  private smoothStruggle = 0

  public reset() {
    this.centerOffset = 0
    this.lastMidXRatio = 0.5
    this.baseShoulderY = null
    this.prevMidY = null
    this.prevLean = 0
    this.lastFrameTime = null
    this.guardSince = null
    this.prevGuardActive = false
    this.beamHold.reset()
    this.beamFired = false
    this.spreadHold.reset()
    this.transformHold.reset()
    this.transformFired = false
    this.typeHold.reset()
    this.typeFired = false
    this.discRaiseStart = [null, null]
    this.discArmed = [null, null]
    this.wristKin = [createWristKinematics(), createWristKinematics()]
    this.punchLast = [-Infinity, -Infinity]
    this.punchPeakLock = [false, false]
    this.kickLast = [-Infinity, -Infinity]
    this.kickKin = [createKickKinematics(), createKickKinematics()]
    this.smoothLean = 0
    this.smoothStruggle = 0
  }

  public recenter() {
    this.centerOffset = this.lastMidXRatio - 0.5
    this.baseShoulderY = null
    this.prevMidY = null
  }

  public update(
    landmarks: PoseLandmark[] | null,
    now: number,
    width = 640,
    height = 480,
    worldLandmarks?: PoseLandmark[] | null,
    canChangeForm = true,
    laneCenter?: number,
  ): GestureSnapshot {
    const out: GestureSnapshot = {
      tracking: false,
      coverage: 'none',
      lean: this.smoothLean * 0.9,
      lateralVelocity: 0,
      guard: false,
      guardJustStarted: false,
      punch: null,
      punchStyle: 'jab',
      kick: null,
      discCharge: 0,
      discSide: null,
      discTrigger: null,
      typeCharge: 0,
      typeTrigger: false,
      beamCharge: 0,
      beamTrigger: false,
      beamHolding: false,
      beamArmSide: 'right',
      transformProgress: 0,
      transformTrigger: false,
      spreadProgress: 0,
      isSpreading: false,
      strugglePower: 0,
      mirroredCenterX: 1 - this.lastMidXRatio,
      livePose: null,
      hintKey: 'hintStandCenter',
    }

    if (
      !landmarks ||
      landmarks.length < 33 ||
      width <= 0 ||
      height <= 0 ||
      (this.lastFrameTime !== null && (now < this.lastFrameTime || now - this.lastFrameTime > 1400))
    ) {
      this.reset()
      this.lastFrameTime = now
      return out
    }
    const deltaSeconds =
      this.lastFrameTime === null ? 1 / 60 : clamp((now - this.lastFrameTime) / 1000, 0.004, 0.12)
    this.lastFrameTime = now

    const rawPts: Vec3[] = landmarks.map((lm) => ({
      x: lm.x * width,
      y: lm.y * height,
      z: (lm.z ?? 0) * width,
      v: lm.x >= -0.08 && lm.x <= 1.08 && lm.y >= -0.08 && lm.y <= 1.08 ? (lm.visibility ?? 1) : 0,
    }))

    const worldPts: Vec3[] =
      worldLandmarks && worldLandmarks.length === landmarks.length
        ? worldLandmarks.map((lm, idx) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z ?? 0,
            v: Math.min(lm.visibility ?? 1, rawPts[idx]!.v),
          }))
        : rawPts.map((p) => ({
            x: p.x / width,
            y: p.y / width,
            z: (p.z / width) * 0.85,
            v: p.v,
          }))

    const worldLeft = worldPts[11]!
    const worldRight = worldPts[12]!
    const armScale = Math.hypot(
      worldLeft.x - worldRight.x,
      worldLeft.y - worldRight.y,
      worldLeft.z - worldRight.z,
    )
    const lsRaw = rawPts[11]
    const rsRaw = rawPts[12]
    if (!isVisible(lsRaw, 0.34) || !isVisible(rsRaw, 0.34)) {
      return out
    }

    const shoulderWidth = dist2D(lsRaw, rsRaw)
    if (shoulderWidth < width * 0.036) {
      return out
    }
    const scale = Math.max(shoulderWidth, height * 0.068)

    // 1. 高灵敏度身体重心横向位移（融合双肩与骨盆中心，大步左右闪避零延迟）
    const lhRaw = rawPts[23]
    const rhRaw = rawPts[24]
    const hasRawHips = isVisible(lhRaw, 0.35) && isVisible(rhRaw, 0.35)
    const shoulderMidX = (lsRaw.x + rsRaw.x) * 0.5
    const midX = hasRawHips ? shoulderMidX * 0.65 + ((lhRaw.x + rhRaw.x) * 0.5) * 0.35 : shoulderMidX
    const midY = (lsRaw.y + rsRaw.y) * 0.5
    this.lastMidXRatio = midX / width
    out.mirroredCenterX = 1 - this.lastMidXRatio

    const offsetFromCenter = this.lastMidXRatio - (0.5 + this.centerOffset)
    // 扩大体感走位灵敏区间（0.21 画面宽度即可拉满横向躲避行程，更适合客厅电视前走位）
    const rawLean = clamp(-offsetFromCenter / 0.21, -1, 1)
    const lean =
      laneCenter === undefined ? rawLean : clamp((laneCenter - midX / width) / 0.14, -1, 1)
    this.smoothLean += (lean - this.smoothLean) * -Math.expm1(-18 * deltaSeconds)
    const filteredLean = Math.abs(this.smoothLean) < 0.04 ? 0 : this.smoothLean
    out.lateralVelocity = clamp((filteredLean - this.prevLean) / deltaSeconds, -8, 8)
    this.prevLean = filteredLean
    out.lean = filteredLean

    let verticalRunEnergy = 0
    if (this.baseShoulderY === null) {
      this.baseShoulderY = midY
      this.prevMidY = midY
    } else {
      const verticalSpeed = Math.abs(midY - (this.prevMidY ?? midY)) / (scale * deltaSeconds)
      verticalRunEnergy = clamp((verticalSpeed - 0.35) * 0.45, 0, 1)
      this.prevMidY = midY
      if (verticalSpeed < 0.9) {
        const adaptRate = Math.abs(this.baseShoulderY - midY) < scale * 0.22 ? 1.8 : 0.75
        this.baseShoulderY += (midY - this.baseShoulderY) * Math.min(1, deltaSeconds * adaptRate)
      }
    }

    const deltaY = (this.baseShoulderY - midY) / scale
    const jumpHeight = deltaY > 0.17 ? clamp((deltaY - 0.17) * 5.2, 0, 5.2) : 0
    const crouchDepth = deltaY < -0.12 ? clamp((-deltaY - 0.12) * 3.4, 0, 2.8) : 0

    // 2. 构建实时全身 3D 骨骼映射包
    const livePose = this.extractLiveBodyPose(worldPts, jumpHeight, crouchDepth)
    out.livePose = livePose
    out.tracking = true
    out.coverage = livePose.coverage
    out.hintKey = 'hintReady'

    // 3. 检测发力抬腿飞踢（带速度与正向加速度门控）
    if (livePose.coverage === 'full') {
      this.detectKick(rawPts, now, deltaSeconds, scale, out)
    }

    // 4. 双肩水平校正后的 2D 坐标用于招式几何判定
    const pts: Vec3[] = rawPts.map((p) => ({ ...p }))
    const dx = rsRaw.x - lsRaw.x
    const dy = rsRaw.y - lsRaw.y
    const sign = Math.sign(dx) || 1
    const roll = Math.atan2(dy * sign, dx * sign)
    const cos = Math.cos(roll)
    const sin = Math.sin(roll)
    for (const p of pts) {
      const rx = p.x - midX
      const ry = p.y - midY
      p.x = midX + rx * cos + ry * sin
      p.y = midY - rx * sin + ry * cos
    }

    const ls = pts[11]!
    const rs = pts[12]!
    const le = pts[13]
    const re = pts[14]
    const lw = pts[15]
    const rw = pts[16]

    // 无论当前处于哪个招式分支，始终实时累积角力推力能量（双臂挥动速度 + 原地踏步冲刺）
    const armAgitation = this.sampleStruggleAgitation(pts, deltaSeconds, scale)
    const instantStruggle = clamp(armAgitation * 0.8 + verticalRunEnergy * 0.45, 0, 1)
    this.smoothStruggle +=
      (instantStruggle - this.smoothStruggle) * -Math.expm1(-12 * deltaSeconds)
    out.strugglePower = this.smoothStruggle

    // 优先检测：单手高举变身（高举神光棒过头顶）
    const nose = pts[0]
    const centerY = (ls.y + rs.y) * 0.5
    const headTopY =
      isVisible(nose, 0.28) && nose.y < centerY - scale * 0.16
        ? nose.y - scale * 0.28
        : centerY - scale * 0.58

    const leftRaisedHigh = isVisible(lw, 0.24) && lw.y < headTopY - scale * 0.14
    const rightRaisedHigh = isVisible(rw, 0.24) && rw.y < headTopY - scale * 0.14
    const isTransformPose =
      (leftRaisedHigh && !rightRaisedHigh) ||
      (rightRaisedHigh && !leftRaisedHigh) ||
      (leftRaisedHigh && rightRaisedHigh)
    const transformElapsed = this.transformHold.update(isTransformPose, now)
    if (isTransformPose || this.transformHold.isRecent(now)) {
      out.transformProgress = clamp(transformElapsed / 560, 0, 1)
      if (out.transformProgress >= 1 && !this.transformFired) {
        out.transformTrigger = true
        this.transformFired = true
      }
    } else {
      this.transformFired = false
    }

    // 手机竖屏或近距离时，双臂真正水平平举（T 字）可能令手腕贴出左右边缘；
    // 严格要求双肘抬至肩平线内（|e.y - centerY| < 0.40 * scale）且双肘大幅外扩（span > 1.75），彻底避免自然垂臂误判！
    const elbowsVisible = isVisible(le, 0.26) && isVisible(re, 0.26)
    const elbowSpanRaw = elbowsVisible ? Math.abs(le.x - re.x) / scale : 0
    const elbowsAtShoulderLevel =
      elbowsVisible &&
      Math.abs(le.y - centerY) < scale * 0.4 &&
      Math.abs(re.y - centerY) < scale * 0.4
    const elbowsWideSpread = elbowsAtShoulderLevel && elbowSpanRaw > 1.75

    if (
      !elbowsVisible ||
      !isVisible(lw, 0.2) ||
      !isVisible(rw, 0.2)
    ) {
      this.beamHold.reset()
      this.typeHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.guardSince = null
      this.prevGuardActive = false
      const partialSpreadElapsed = this.spreadHold.update(elbowsWideSpread, now)
      if (elbowsWideSpread || this.spreadHold.isRecent(now)) {
        out.isSpreading = elbowsWideSpread
        out.spreadProgress = clamp(partialSpreadElapsed / 420, 0, 1)
      }
      if (!elbowsWideSpread && armScale > 0) {
        this.detectPunchOmnidirectional(pts, worldPts, now, deltaSeconds, scale, armScale, out)
      }
      out.hintKey = out.punch ? 'hintPunch' : 'hintShowArms'
      return out
    }

    const forearms: [Vec3, Vec3][] = [
      [le, lw],
      [re, rw],
    ]
    const angles = forearms.map(
      ([e, w]) => (Math.atan2(Math.abs(w.y - e.y), Math.abs(w.x - e.x)) * 180) / Math.PI,
    )
    const minAngle = Math.min(angles[0]!, angles[1]!)
    const maxAngle = Math.max(angles[0]!, angles[1]!)
    const avgWristY = (lw.y + rw.y) * 0.5
    const inChestZone = avgWristY > centerY - scale * 0.95 && avgWristY < centerY + scale * 1.85
    const forearmsCross = segmentsCross(le, lw, re, rw)
    const crossedWrists = (lw.x - rw.x) * (ls.x - rs.x) < 0
    const wristsNearCenter =
      Math.abs(lw.x - rw.x) < scale * 0.52 &&
      Math.abs((lw.x + rw.x) * 0.5 - midX) < scale * 0.65

    // 招式 S：双臂水平展开蓄力（严格 T 字平展：双肘与双腕均处于肩平带且向外大幅拉开）
    const wristSpan = Math.abs(lw.x - rw.x) / scale
    const elbowSpan = elbowSpanRaw
    const wristsShoulderBand =
      Math.abs(lw.y - centerY) < scale * 0.58 && Math.abs(rw.y - centerY) < scale * 0.58
    const isSpreadPose =
      elbowsAtShoulderLevel &&
      elbowSpan > 1.55 &&
      wristSpan > 2.25 &&
      wristSpan > elbowSpan + 0.45 &&
      wristsShoulderBand &&
      !crossedWrists &&
      !forearmsCross
    const spreadElapsed = this.spreadHold.update(isSpreadPose, now)
    if (isSpreadPose || this.spreadHold.isRecent(now)) {
      out.isSpreading = isSpreadPose
      out.spreadProgress = clamp(spreadElapsed / 420, 0, 1)
    }

    // 招式 A：胸前 X 双臂交叉防御（40ms 秒开，宽容度更高）
    const strictGuard =
      crossedWrists &&
      inChestZone &&
      angles[0]! > 16 &&
      angles[0]! < 85 &&
      angles[1]! > 16 &&
      angles[1]! < 85 &&
      forearmsCross
    const compactGuard =
      wristsNearCenter &&
      inChestZone &&
      angles[0]! > 28 &&
      angles[1]! > 28 &&
      Math.abs(lw.y - rw.y) < scale * 0.55 &&
      lw.y < le.y + scale * 0.15 &&
      rw.y < re.y + scale * 0.15
    const isGuardPose = strictGuard || compactGuard

    if (isGuardPose) {
      this.beamHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      if (this.guardSince === null) this.guardSince = now
      out.guard = now - this.guardSince >= 40
      out.guardJustStarted = out.guard && !this.prevGuardActive
      this.prevGuardActive = out.guard
      out.hintKey = out.guard ? 'hintGuardActive' : 'hintGuardPrep'
      return out
    }
    this.guardSince = null
    this.prevGuardActive = false

    // 招式 A2：双手交叉举过头顶 1.0 秒切换形态（迪迦 / 戴拿）
    const elbowsHigh = le.y < centerY - scale * 0.22 && re.y < centerY - scale * 0.22
    const wristsAboveHead = lw.y < headTopY && rw.y < headTopY
    const wristsCloseOrCrossed =
      (lw.x - rw.x) * (ls.x - rs.x) < 0 || Math.abs(lw.x - rw.x) < scale * 0.52
    const isTypePose = canChangeForm && elbowsHigh && wristsAboveHead && wristsCloseOrCrossed

    const typeElapsed = this.typeHold.update(isTypePose, now)
    if (isTypePose || this.typeHold.isRecent(now)) {
      out.typeCharge = clamp(typeElapsed / 1000, 0, 1)
      out.hintKey = 'hintTypeCharge'
      if (out.typeCharge >= 1 && !this.typeFired) {
        out.typeTrigger = true
        this.typeFired = true
        out.hintKey = 'hintTypeSwitch'
      }
      if (isTypePose) {
        this.discRaiseStart = [null, null]
        this.discArmed = [null, null]
        this.beamHold.reset()
        return out
      }
      return out
    }
    this.typeFired = false

    // 招式 B：必杀光线（经典 L 字或十字 + 姿势，宽容度升级，280ms 迅捷触发）
    const forearmGap =
      Math.min(
        segmentDistance(lw, re, rw),
        segmentDistance(rw, le, lw),
        segmentDistance(le, re, rw),
        segmentDistance(re, le, lw),
      ) / scale
    const leftUpward = angles[0]! > 44 && lw.y < le.y - scale * 0.12
    const rightUpward = angles[1]! > 44 && rw.y < re.y - scale * 0.12
    const oneUpward = leftUpward || rightUpward
    const beamSide: 'left' | 'right' = leftUpward && !rightUpward ? 'left' : 'right'
    out.beamArmSide = beamSide
    livePose.beamArmSide = beamSide

    const isBeamPose =
      !this.discArmed[0] &&
      !this.discArmed[1] &&
      minAngle < 46 &&
      maxAngle > 44 &&
      maxAngle - minAngle > 22 &&
      forearmGap < 0.78 &&
      inChestZone &&
      oneUpward

    const beamElapsed = this.beamHold.update(isBeamPose, now)
    const beamRequiredMs = 280
    if (isBeamPose || (beamElapsed > 0 && this.beamHold.isRecent(now))) {
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      out.beamHolding = isBeamPose
      out.beamCharge = clamp(beamElapsed / beamRequiredMs, 0, 1)
      out.hintKey = 'hintBeamCharge'
      if (out.beamCharge >= 1 && !this.beamFired) {
        out.beamTrigger = true
        this.beamFired = true
        out.hintKey = 'hintBeamFire'
      }
      return out
    } else if (!this.beamHold.isRecent(now)) {
      this.beamFired = false
    }

    // 招式 C：光轮斩（单手高举凝聚 → 发力向下/向前挥劈；慢速放手自动取消蓄力而不误丢）
    for (let side = 0; side < 2; side++) {
      const wrist = side === 0 ? lw : rw
      const shoulder = side === 0 ? ls : rs
      const sideName: 'left' | 'right' = side === 0 ? 'left' : 'right'
      const relX = (wrist.x - shoulder.x) / scale
      const relY = (wrist.y - shoulder.y) / scale
      const relZ = (wrist.z - shoulder.z) / scale
      const isHigh = wrist.y < headTopY && angles[side]! > 46
      const kin = this.wristKin[side]!

      const armed = this.discArmed[side]
      if (armed) {
        if (now - armed.time > 2000) {
          this.discArmed[side] = null
          this.discRaiseStart[side] = null
          continue
        }
        const drop = relY - armed.relY
        const forward = armed.relZ - relZ
        const outward = (relX - armed.relX) * (shoulder.x < midX ? -1 : 1)
        const slashFast =
          kin.vy2 > 2.1 ||
          kin.speed2D > 2.85 ||
          kin.forwardVel3D > 1.45 ||
          (now - kin.peakAccel2DAt <= 160 && kin.peakAccel2D > 14.5)
        out.discSide = sideName
        out.discCharge = 1
        out.hintKey = 'hintDiscThrow'
        if (drop > 0.34 && (forward > 0.05 || outward > 0.3 || drop > 0.58)) {
          if (slashFast) {
            out.discTrigger = sideName
            out.hintKey = 'hintDiscFire'
            this.discArmed = [null, null]
            this.discRaiseStart = [null, null]
            return out
          }
          // 慢速放下手臂：平滑取消光轮准备态，不误扔
          if (drop > 0.72) {
            this.discArmed[side] = null
            this.discRaiseStart[side] = null
          }
        }
        if (isHigh && relY < armed.relY) {
          armed.relY = relY
        }
      } else if (isHigh) {
        if (this.discRaiseStart[side] === null) this.discRaiseStart[side] = now
        const progress = clamp((now - this.discRaiseStart[side]!) / 260, 0, 1)
        out.discSide = sideName
        out.discCharge = progress
        out.hintKey = 'hintDiscCharge'
        if (progress >= 1) {
          this.discArmed[side] = { time: now, relX, relY, relZ }
        }
        return out
      } else {
        this.discRaiseStart[side] = null
      }
    }

    // 招式 D：基于速度 + 加速度物理发力判定的全向左右挥拳
    if (!isSpreadPose && armScale > 0) {
      this.detectPunchOmnidirectional(pts, worldPts, now, deltaSeconds, scale, armScale, out)
    }
    return out
  }

  /** 采样双臂往复发力挥动强度（用于近身角力推力 QTE，过滤慢速微摆） */
  private sampleStruggleAgitation(pts: Vec3[], dt: number, scale: number): number {
    const ls = pts[11]!
    const rs = pts[12]!
    const lw = pts[15]
    const rw = pts[16]
    let totalSpeed = 0
    let count = 0

    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? ls : rs
      const w = side === 0 ? lw : rw
      const prev = this.wristKin[side]!.prev2
      if (!isVisible(w, 0.2) || !prev) continue
      const rx = (w.x - s.x) / scale
      const ry = (w.y - s.y) / scale
      const spd = Math.hypot(rx - prev.x, ry - prev.y) / dt
      totalSpeed += spd
      count++
    }
    if (count === 0) return 0
    return clamp((totalSpeed / count - 1.85) / 4.0, 0, 1)
  }

  private extractLiveBodyPose(
    w: Vec3[],
    jumpHeight: number,
    crouchDepth: number,
  ): LiveBodyPose {
    const ls = w[11]!
    const rs = w[12]!
    const lh = w[23]
    const rh = w[24]
    const shoulderMid = avgVec(ls, rs)
    const hasHips = isVisible(lh, 0.34) && isVisible(rh, 0.34)
    const hipMid = hasHips
      ? avgVec(lh, rh)
      : { x: shoulderMid.x, y: shoulderMid.y + 0.45, z: shoulderMid.z, v: 0.5 }

    const torsoDir = mpDirToWorld(hipMid, shoulderMid, 0.72) ?? { x: 0, y: 1, z: 0 }
    const shoulderAxis = mpDirToWorld(ls, rs, 0.88) ?? { x: 1, y: 0, z: 0 }

    const torsoRoll = clamp(
      Math.atan2(shoulderAxis.y, Math.abs(shoulderAxis.x) + 0.15) * 0.85,
      -0.48,
      0.48,
    )
    const torsoPitch = clamp(
      Math.atan2(-torsoDir.z, Math.max(0.25, torsoDir.y)) * 0.8,
      -0.42,
      0.55,
    )
    const torsoYaw = clamp(
      Math.atan2(-shoulderAxis.z, Math.max(0.2, shoulderAxis.x)) * 0.85,
      -0.75,
      0.75,
    )

    let headYaw = 0
    let headPitch = 0
    let headRoll = 0
    const nose = w[0]
    const earL = w[7]
    const earR = w[8]
    if (isVisible(earL, 0.32) && isVisible(earR, 0.32)) {
      const earAxis = mpDirToWorld(earL, earR, 0.82)
      if (earAxis) {
        headRoll = clamp(Math.atan2(earAxis.y, Math.abs(earAxis.x) + 0.1) - torsoRoll, -0.4, 0.4)
        headYaw = clamp(Math.atan2(-earAxis.z, Math.max(0.2, earAxis.x)) - torsoYaw, -0.6, 0.6)
      }
      if (isVisible(nose, 0.36)) {
        const earMid = avgVec(earL, earR)
        const noseDir = mpDirToWorld(earMid, nose, 0.82)
        if (noseDir) {
          headPitch = clamp(
            Math.atan2(-noseDir.y, Math.abs(noseDir.z) + 0.35) * 0.7,
            -0.36,
            0.36,
          )
        }
      }
    }

    const dirIfVisible = (aIdx: number, bIdx: number, thA = 0.3, thB = 0.25): Vec3Like | null => {
      const a = w[aIdx]
      const b = w[bIdx]
      if (!isVisible(a, thA) || !isVisible(b, thB)) return null
      return mpDirToWorld(a, b, 0.92)
    }

    const upperArmL = dirIfVisible(11, 13, 0.34, 0.28)
    const lowerArmL = dirIfVisible(13, 15, 0.28, 0.22)
    const handL = dirIfVisible(15, 19, 0.24, 0.18)
    const upperArmR = dirIfVisible(12, 14, 0.34, 0.28)
    const lowerArmR = dirIfVisible(14, 16, 0.28, 0.22)
    const handR = dirIfVisible(16, 20, 0.24, 0.18)

    const thighL = hasHips ? dirIfVisible(23, 25, 0.42, 0.42) : null
    const shinL = thighL ? dirIfVisible(25, 27, 0.42, 0.38) : null
    const thighR = hasHips ? dirIfVisible(24, 26, 0.42, 0.42) : null
    const shinR = thighR ? dirIfVisible(26, 28, 0.42, 0.38) : null
    const hasLegs = !!(thighL && thighR)

    return {
      active: true,
      coverage: hasLegs ? 'full' : 'upper',
      torsoPitch,
      torsoRoll,
      torsoYaw,
      headYaw,
      headPitch,
      headRoll,
      jumpHeight,
      crouchDepth,
      upperArmL,
      lowerArmL,
      handL,
      upperArmR,
      lowerArmR,
      handR,
      thighL,
      shinL,
      thighR,
      shinR,
      beamArmSide: 'right',
    }
  }

  /**
   * 速度 + 正向加速度门控飞踢检测：
   * 缓慢抬腿/调整站姿仅驱动 3D 腿骨实时跟随摆动，只有爆发向上踢出才触发飞踢攻击。
   */
  private detectKick(pts: Vec3[], now: number, dt: number, scale: number, out: GestureSnapshot) {
    const velAlpha = 1 - Math.exp(-dt / 0.032)
    for (let side = 0; side < 2; side++) {
      const hip = pts[side === 0 ? 23 : 24]
      const knee = pts[side === 0 ? 25 : 26]
      const ankle = pts[side === 0 ? 27 : 28]
      const kin = this.kickKin[side]!
      if (!isVisible(hip, 0.4) || !isVisible(knee, 0.4) || !isVisible(ankle, 0.35)) {
        kin.prevAnkleRelY = null
        kin.prevKneeRelY = null
        kin.upVel = 0
        kin.wasHigh = false
        continue
      }

      const ankleRelY = (hip.y - ankle.y) / scale
      const kneeRelY = (hip.y - knee.y) / scale
      if (kin.prevAnkleRelY !== null && kin.prevKneeRelY !== null) {
        const rawUpVel =
          ((ankleRelY - kin.prevAnkleRelY) * 0.65 + (kneeRelY - kin.prevKneeRelY) * 0.35) / dt
        const prevVel = kin.upVel
        kin.upVel += (rawUpVel - kin.upVel) * velAlpha
        const upAccel = (kin.upVel - prevVel) / dt
        if (upAccel > kin.peakUpAccel || now - kin.peakUpAccelAt > 160) {
          kin.peakUpAccel = Math.max(0, upAccel)
          kin.peakUpAccelAt = now
        }
      }
      kin.prevAnkleRelY = ankleRelY
      kin.prevKneeRelY = kneeRelY

      const kneeRaised = kneeRelY > -0.7
      const ankleRaised = ankleRelY > -1.36
      const isKickHigh = kneeRaised && ankleRaised
      const hasKickBurst =
        kin.upVel > 1.85 && now - kin.peakUpAccelAt <= 180 && kin.peakUpAccel > 11.5

      if (isKickHigh && !kin.wasHigh && hasKickBurst && now - this.kickLast[side]! > 480) {
        this.kickLast[side] = now
        out.kick = side === 0 ? 'left' : 'right'
        out.hintKey = 'hintKick'
      }
      kin.wasHigh = isKickHigh
    }
  }

  /**
   * 物理速度 + 二阶正向加速度脉冲 + 行程 + 反回缩四重门控出拳检测：
   * - 慢速/常速抬手、放手、调整姿势或自然摆臂（低速度 / 低加速度）仅通过 livePose 驱动角色手臂跟随，0 误触攻击；
   * - 真实发力出拳在 140ms 窗口内必然呈现显著正向爆发加速度峰值 + 高击打线速度 + 有效前推/挥摆行程；
   * - 过滤收拳回胸与手臂自然下坠，并通过回落滞回锁彻底防止单拳余震连响。
   */
  private detectPunchOmnidirectional(
    pts2D: Vec3[],
    pts3D: Vec3[],
    now: number,
    dt: number,
    scale2D: number,
    scale3D: number,
    out: GestureSnapshot,
  ) {
    let bestSide: 'left' | 'right' | null = null
    let bestStyle: 'jab' | 'hook' | 'uppercut' = 'jab'
    let bestScore = -Infinity

    // 对一阶速度施加轻度指数低通（τ = 30ms），在零感知延迟下压制单帧检测毛刺对二阶加速度的放大
    const velAlpha = 1 - Math.exp(-dt / 0.03)
    const ACCEL_WINDOW_MS = 145
    const STROKE_WINDOW_MS = 170

    for (let side = 0; side < 2; side++) {
      const s2 = pts2D[side === 0 ? 11 : 12]!
      const w2 = pts2D[side === 0 ? 15 : 16]
      const s3 = pts3D[side === 0 ? 11 : 12]
      const e3 = pts3D[side === 0 ? 13 : 14]
      const w3 = pts3D[side === 0 ? 15 : 16]
      const kin = this.wristKin[side]!

      if (!isVisible(w2, 0.2) || !isVisible(s3, 0.3) || !isVisible(e3, 0.28) || !isVisible(w3, 0.2)) {
        this.wristKin[side] = createWristKinematics()
        this.punchPeakLock[side] = false
        continue
      }

      const relX2 = (w2.x - s2.x) / scale2D
      const relY2 = (w2.y - s2.y) / scale2D
      const relX3 = (w3.x - s3.x) / scale3D
      const relY3 = (w3.y - s3.y) / scale3D
      const relZ3 = (w3.z - s3.z) / scale3D
      const radial2D = Math.hypot(relX2, relY2)
      const elbowDeg = elbowAngleDeg(s3, e3, w3)

      // 若刚从防御/光线/展臂等其他姿态切回（采样中断 > 180ms），重置运动学基线防止跨状态跳变误触发
      const lastSampleT = kin.trail.length > 0 ? kin.trail[kin.trail.length - 1]!.t : -Infinity
      if (now - lastSampleT > 180) {
        this.wristKin[side] = createWristKinematics()
        const fresh = this.wristKin[side]!
        fresh.prev2 = { x: relX2, y: relY2 }
        fresh.prev3 = { x: relX3, y: relY3, z: relZ3 }
        fresh.prevElbowDeg = elbowDeg
        fresh.prevRadial2D = radial2D
        fresh.trail.push({ t: now, x2: relX2, y2: relY2, x3: relX3, y3: relY3, z3: relZ3 })
        continue
      }

      if (kin.prev2 && kin.prev3 && kin.prevElbowDeg !== null && kin.prevRadial2D !== null) {
        const rawVx2 = (relX2 - kin.prev2.x) / dt
        const rawVy2 = (relY2 - kin.prev2.y) / dt
        const rawSpeed2D = Math.hypot(rawVx2, rawVy2)
        const rawFwdVel3D = (kin.prev3.z - relZ3) / dt
        const rawSpeed3D =
          Math.hypot(relX3 - kin.prev3.x, relY3 - kin.prev3.y, relZ3 - kin.prev3.z) / dt
        const rawElbowVel = (elbowDeg - kin.prevElbowDeg) / dt
        const rawRadialVel = (radial2D - kin.prevRadial2D) / dt

        const prevSpeed2D = kin.speed2D
        const prevVy2 = kin.vy2
        const prevFwdVel = kin.forwardVel3D
        const prevSpeed3D = kin.speed3D
        const prevElbowVel = kin.elbowVel

        kin.vx2 += (rawVx2 - kin.vx2) * velAlpha
        kin.vy2 += (rawVy2 - kin.vy2) * velAlpha
        kin.speed2D += (rawSpeed2D - kin.speed2D) * velAlpha
        kin.forwardVel3D += (rawFwdVel3D - kin.forwardVel3D) * velAlpha
        kin.speed3D += (rawSpeed3D - kin.speed3D) * velAlpha
        kin.elbowVel += (rawElbowVel - kin.elbowVel) * velAlpha
        kin.radialVel2D += (rawRadialVel - kin.radialVel2D) * velAlpha

        // 计算二阶正向爆发加速度（仅在发力加速段上升，匀速或减速段不产生正峰值）
        const accel2D = (kin.speed2D - prevSpeed2D) / dt
        const upAccel = (prevVy2 - kin.vy2) / dt
        const fwdAccel = (kin.forwardVel3D - prevFwdVel) / dt
        const speed3DAccel = (kin.speed3D - prevSpeed3D) / dt
        const elbowAccel = (kin.elbowVel - prevElbowVel) / dt

        if (accel2D >= kin.peakAccel2D || now - kin.peakAccel2DAt > ACCEL_WINDOW_MS) {
          kin.peakAccel2D = Math.max(0, accel2D)
          kin.peakAccel2DAt = now
        }
        if (upAccel >= kin.peakUpAccel || now - kin.peakUpAccelAt > ACCEL_WINDOW_MS) {
          kin.peakUpAccel = Math.max(0, upAccel)
          kin.peakUpAccelAt = now
        }
        if (fwdAccel >= kin.peakFwdAccel || now - kin.peakFwdAccelAt > ACCEL_WINDOW_MS) {
          kin.peakFwdAccel = Math.max(0, fwdAccel)
          kin.peakFwdAccelAt = now
        }
        if (speed3DAccel >= kin.peakSpeed3DAccel || now - kin.peakSpeed3DAccelAt > ACCEL_WINDOW_MS) {
          kin.peakSpeed3DAccel = Math.max(0, speed3DAccel)
          kin.peakSpeed3DAccelAt = now
        }
        if (elbowAccel >= kin.peakElbowAccel || now - kin.peakElbowAccelAt > ACCEL_WINDOW_MS) {
          kin.peakElbowAccel = Math.max(0, elbowAccel)
          kin.peakElbowAccelAt = now
        }
      }

      kin.prev2 = { x: relX2, y: relY2 }
      kin.prev3 = { x: relX3, y: relY3, z: relZ3 }
      kin.prevElbowDeg = elbowDeg
      kin.prevRadial2D = radial2D

      kin.trail.push({ t: now, x2: relX2, y2: relY2, x3: relX3, y3: relY3, z3: relZ3 })
      while (kin.trail.length > 1 && now - kin.trail[0]!.t > STROKE_WINDOW_MS) {
        kin.trail.shift()
      }
      const oldest = kin.trail[0]!
      const stroke2D = Math.hypot(relX2 - oldest.x2, relY2 - oldest.y2)
      const stroke3D = Math.hypot(relX3 - oldest.x3, relY3 - oldest.y3, relZ3 - oldest.z3)
      const forwardStroke3D = oldest.z3 - relZ3

      // 当手腕回落至正常慢速区或明显进入收拳回撤时，解除本次出拳波峰锁
      const isRetracting = kin.forwardVel3D < -0.55 && kin.radialVel2D < -0.75
      if ((kin.speed2D < 1.85 && kin.forwardVel3D < 0.7) || isRetracting) {
        this.punchPeakLock[side] = false
      }

      const inStrikeZone = relY2 > -0.88 && relY2 < 1.2
      const cooldownOk = now - this.punchLast[side]! > 260 && !this.punchPeakLock[side]
      if (!cooldownOk || !inStrikeZone) continue

      const hasRecentFwdAccel = now - kin.peakFwdAccelAt <= ACCEL_WINDOW_MS && kin.peakFwdAccel >= 13.5
      const hasRecent3DAccel = now - kin.peakSpeed3DAccelAt <= ACCEL_WINDOW_MS && kin.peakSpeed3DAccel >= 16.0
      const hasRecent2DAccel = now - kin.peakAccel2DAt <= ACCEL_WINDOW_MS && kin.peakAccel2D >= 18.5
      const hasRecentUpAccel = now - kin.peakUpAccelAt <= ACCEL_WINDOW_MS && kin.peakUpAccel >= 18.0
      const hasRecentElbowAccel =
        now - kin.peakElbowAccelAt <= ACCEL_WINDOW_MS && kin.peakElbowAccel >= 1350

      // 反回缩与反自然垂臂过滤：收拳往后拉回胸（Z 明显后退）或手臂向下自然放下时绝不触发攻击
      const notDroppingArm = kin.vy2 < 1.75
      const notPullingBack = kin.forwardVel3D > -0.55

      // 通道 1：爆发前刺直拳（高速前冲 + 正向加速度峰值 + 有效前推行程）
      const isForwardJab =
        elbowDeg > 102 &&
        forwardStroke3D > 0.14 &&
        stroke3D > 0.24 &&
        ((kin.forwardVel3D > 1.85 && kin.speed3D > 2.2 && (hasRecentFwdAccel || hasRecent3DAccel)) ||
          (kin.elbowVel > 215 && kin.forwardVel3D > 0.85 && hasRecentElbowAccel))

      // 通道 2：爆发横摆拳 / 勾拳（高速横向挥臂 + 显著正向加速度脉冲 + 有效摆拳行程，过滤慢挥与收拳）
      const isSwingHook =
        notDroppingArm &&
        notPullingBack &&
        kin.speed2D > 3.45 &&
        Math.abs(kin.vx2) > 2.45 &&
        hasRecent2DAccel &&
        stroke2D > 0.34 &&
        elbowDeg > 58

      // 通道 3：爆发上勾升龙拳（高速上冲 + 向上爆发加速度 + 有效上挥行程，过滤慢举手）
      const isUppercut =
        kin.speed2D > 3.35 &&
        kin.vy2 < -2.75 &&
        hasRecentUpAccel &&
        stroke2D > 0.32 &&
        relY2 < 0.52

      if (isForwardJab || isSwingHook || isUppercut) {
        const score =
          kin.speed2D * 0.45 +
          Math.max(0, kin.forwardVel3D) * 0.75 +
          kin.peakAccel2D * 0.04 +
          kin.peakFwdAccel * 0.05
        if (score > bestScore) {
          bestScore = score
          bestSide = side === 0 ? 'left' : 'right'
          bestStyle = isUppercut ? 'uppercut' : isSwingHook ? 'hook' : 'jab'
        }
      }
    }

    if (bestSide) {
      const idx = bestSide === 'left' ? 0 : 1
      this.punchLast[idx] = now
      this.punchPeakLock[idx] = true
      out.punch = bestSide
      out.punchStyle = bestStyle
      out.hintKey = 'hintPunch'
    }
  }
}
