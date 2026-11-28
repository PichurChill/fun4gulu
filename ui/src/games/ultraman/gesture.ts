import type {
  DistanceHint,
  GestureActiveCue,
  GestureSnapshot,
  LiveBodyPose,
  LiveHandFingers,
  PoseLandmark,
  PunchStyle,
  StrikeHeight,
  Vec3Like,
} from './types'

export interface HandLandmarksInput {
  left?: PoseLandmark[] | null
  leftWorld?: PoseLandmark[] | null
  right?: PoseLandmark[] | null
  rightWorld?: PoseLandmark[] | null
}

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

/** 单臂速度 + 爆发加速度与有效击打行程动力学状态 */
interface WristKinematics {
  prev2: { x: number; y: number } | null
  prev3: { x: number; y: number; z: number } | null
  prevElbowDeg: number | null
  prevRadial2D: number | null
  vx2: number
  vy2: number
  speed2D: number
  forwardVel3D: number
  speed3D: number
  elbowVel: number
  radialVel2D: number
  peakAccel2D: number
  peakAccel2DAt: number
  peakUpAccel: number
  peakUpAccelAt: number
  peakDownAccel: number
  peakDownAccelAt: number
  peakFwdAccel: number
  peakFwdAccelAt: number
  peakSpeed3DAccel: number
  peakSpeed3DAccelAt: number
  peakElbowAccel: number
  peakElbowAccelAt: number
  trail: MotionSample[]
}

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
    peakDownAccel: 0,
    peakDownAccelAt: -Infinity,
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

function vecAngleDeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const denom = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)
  if (denom < 1e-6) return 0
  const cos = clamp((ax * bx + ay * by + az * bz) / denom, -1, 1)
  return (Math.acos(cos) * 180) / Math.PI
}

function cross3(a: Vec3Like, b: Vec3Like): Vec3Like | null {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  const len = Math.hypot(x, y, z)
  if (len < 1e-5) return null
  return { x: x / len, y: y / len, z: z / len }
}

/**
 * 从 MediaPipe HandLandmarker 的 21 关节 3D 坐标解算五指弯曲度、张开度与掌心朝向
 */
export function extractHandFingers(
  handWorld: PoseLandmark[] | null | undefined,
  hand2D: PoseLandmark[] | null | undefined,
  isLeft: boolean,
): LiveHandFingers | null {
  const src = handWorld && handWorld.length >= 21 ? handWorld : hand2D && hand2D.length >= 21 ? hand2D : null
  if (!src) return null

  const p = (idx: number): Vec3 => {
    const lm = src[idx]!
    return { x: lm.x, y: lm.y, z: lm.z ?? 0, v: 1 }
  }
  const wrist = p(0)
  const idxMcp = p(5)
  const midMcp = p(9)
  const pnkMcp = p(17)

  const fingerCurl = (mcpIdx: number, pipIdx: number, dipIdx: number, tipIdx: number): number => {
    const m = p(mcpIdx)
    const pi = p(pipIdx)
    const d = p(dipIdx)
    const ti = p(tipIdx)
    const bendMcp = vecAngleDeg(m.x - wrist.x, m.y - wrist.y, m.z - wrist.z, pi.x - m.x, pi.y - m.y, pi.z - m.z)
    const bendPip = vecAngleDeg(pi.x - m.x, pi.y - m.y, pi.z - m.z, d.x - pi.x, d.y - pi.y, d.z - pi.z)
    const bendDip = vecAngleDeg(d.x - pi.x, d.y - pi.y, d.z - pi.z, ti.x - d.x, ti.y - d.y, ti.z - d.z)
    const weightedBend = bendMcp * 0.42 + bendPip * 0.4 + bendDip * 0.18
    return clamp((weightedBend - 14) / 70, 0, 1)
  }

  const tCmc = p(1)
  const tMcp = p(2)
  const tIp = p(3)
  const tTip = p(4)
  const tBend1 = vecAngleDeg(tMcp.x - tCmc.x, tMcp.y - tCmc.y, tMcp.z - tCmc.z, tIp.x - tMcp.x, tIp.y - tMcp.y, tIp.z - tMcp.z)
  const tBend2 = vecAngleDeg(tIp.x - tMcp.x, tIp.y - tMcp.y, tIp.z - tMcp.z, tTip.x - tIp.x, tTip.y - tIp.y, tTip.z - tIp.z)
  const palmWidth = Math.max(1e-4, Math.hypot(idxMcp.x - pnkMcp.x, idxMcp.y - pnkMcp.y, idxMcp.z - pnkMcp.z))
  const tipToPinky = Math.hypot(tTip.x - pnkMcp.x, tTip.y - pnkMcp.y, tTip.z - pnkMcp.z) / palmWidth
  const thumbAngleCurl = clamp((tBend1 * 0.55 + tBend2 * 0.45 - 12) / 52, 0, 1)
  const thumbTuckCurl = clamp((1.52 - tipToPinky) / 0.82, 0, 1)
  const thumb = clamp(Math.max(thumbAngleCurl, thumbTuckCurl * 0.85), 0, 1)

  const index = fingerCurl(5, 6, 7, 8)
  const mid = fingerCurl(9, 10, 11, 12)
  const ring = fingerCurl(13, 14, 15, 16)
  const pinky = fingerCurl(17, 18, 19, 20)

  const fDir = (a: number, b: number) => {
    const pa = p(a)
    const pb = p(b)
    return { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z }
  }
  const dIdx = fDir(5, 6)
  const dMid = fDir(9, 10)
  const dRing = fDir(13, 14)
  const dPnk = fDir(17, 18)
  const avgSpreadDeg =
    (vecAngleDeg(dIdx.x, dIdx.y, dIdx.z, dMid.x, dMid.y, dMid.z) +
      vecAngleDeg(dMid.x, dMid.y, dMid.z, dRing.x, dRing.y, dRing.z) +
      vecAngleDeg(dRing.x, dRing.y, dRing.z, dPnk.x, dPnk.y, dPnk.z)) /
    3
  const openFactor = clamp(1 - (index + mid + ring + pinky) * 0.3, 0, 1)
  const splay = clamp((avgSpreadDeg - 7.5) / 13.5, 0, 1) * openFactor

  const vIndex = mpDirToWorld(wrist, idxMcp, 1.0)
  const vPinky = mpDirToWorld(wrist, pnkMcp, 1.0)
  const handDir = mpDirToWorld(wrist, midMcp, 1.0)
  const palmNormal =
    vIndex && vPinky ? (isLeft ? cross3(vPinky, vIndex) : cross3(vIndex, vPinky)) : null

  return {
    thumb,
    index,
    mid,
    ring,
    pinky,
    splay,
    palmNormal,
    handDir,
  }
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
 * 物理动力学与动作意图体感引擎：
 * - 自适应短窗动量积分 + 爆发加速度识别 5 种打击意图（直拳 / 摆拳 / 上勾 / 推掌 / 手刀劈）及发力强度/击打高度
 * - 消除拳击抱架误开护盾，严格区分“胸前交叉静架护盾”与“活跃出拳备战”
 * - 完整输出横移速度、深蹲、起跳、客厅站距提示与雷达实时高亮反馈
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

  private wristKin: [WristKinematics, WristKinematics] = [
    createWristKinematics(),
    createWristKinematics(),
  ]
  private punchLast: [number, number] = [-Infinity, -Infinity]
  private punchPeakLock: [boolean, boolean] = [false, false]
  private lastCue: GestureActiveCue = 'none'
  private lastCueUntil = -Infinity

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
    this.lastCue = 'none'
    this.lastCueUntil = -Infinity
  }

  public recenter() {
    this.centerOffset = this.lastMidXRatio - 0.5
    this.baseShoulderY = null
    this.prevMidY = null
  }

  private holdCue(cue: GestureActiveCue, now: number, durationMs = 220) {
    this.lastCue = cue
    this.lastCueUntil = now + durationMs
  }

  public update(
    landmarks: PoseLandmark[] | null,
    now: number,
    width = 640,
    height = 480,
    worldLandmarks?: PoseLandmark[] | null,
    canChangeForm = true,
    laneCenter?: number,
    hands?: HandLandmarksInput | null,
  ): GestureSnapshot {
    const out: GestureSnapshot = {
      tracking: false,
      coverage: 'none',
      distanceHint: 'off-center',
      activeCue: now < this.lastCueUntil ? this.lastCue : 'none',
      lean: this.smoothLean * 0.9,
      lateralVelocity: 0,
      crouching: false,
      crouchDepth: 0,
      jumping: false,
      guard: false,
      guardJustStarted: false,
      punch: null,
      punchStyle: 'jab',
      punchPower: 0.7,
      punchHeight: 'mid',
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
      out.distanceHint = 'too-far'
      return out
    }
    const scale = Math.max(shoulderWidth, height * 0.068)

    // 1. 客厅站距与居中检测 + 非线性死区横移（微晃不滑冰、跨步极速闪避）
    const lhRaw = rawPts[23]
    const rhRaw = rawPts[24]
    const hasRawHips = isVisible(lhRaw, 0.35) && isVisible(rhRaw, 0.35)
    const shoulderMidX = (lsRaw.x + rsRaw.x) * 0.5
    const midX = hasRawHips ? shoulderMidX * 0.62 + ((lhRaw.x + rhRaw.x) * 0.5) * 0.38 : shoulderMidX
    const midY = (lsRaw.y + rsRaw.y) * 0.5
    this.lastMidXRatio = midX / width
    out.mirroredCenterX = 1 - this.lastMidXRatio

    const shoulderWidthRatio = shoulderWidth / width
    let distHint: DistanceHint = 'ok'
    if (shoulderWidthRatio > 0.39) distHint = 'too-close'
    else if (shoulderWidthRatio < 0.088) distHint = 'too-far'
    else if (laneCenter === undefined && Math.abs(this.lastMidXRatio - (0.5 + this.centerOffset)) > 0.28) {
      distHint = 'off-center'
    }
    out.distanceHint = distHint

    const offsetFromCenter = this.lastMidXRatio - (0.5 + this.centerOffset)
    const deadzone = laneCenter === undefined ? 0.032 : 0.022
    const signedOffset =
      Math.abs(offsetFromCenter) <= deadzone
        ? 0
        : Math.sign(offsetFromCenter) * (Math.abs(offsetFromCenter) - deadzone)
    const rawLeanLinear = clamp(-signedOffset / 0.16, -1, 1)
    // 轻度非线性加速曲线：小偏平稳，迈出半步迅速到位
    const rawLean = Math.sign(rawLeanLinear) * Math.pow(Math.abs(rawLeanLinear), 0.85)
    const lean =
      laneCenter === undefined ? rawLean : clamp((laneCenter - midX / width) / 0.14, -1, 1)
    this.smoothLean += (lean - this.smoothLean) * -Math.expm1(-26 * deltaSeconds)
    const filteredLean = Math.abs(this.smoothLean) < 0.035 ? 0 : this.smoothLean
    out.lateralVelocity = clamp((filteredLean - this.prevLean) / deltaSeconds, -8, 8)
    this.prevLean = filteredLean
    out.lean = filteredLean
    if (Math.abs(out.lateralVelocity) > 1.85) {
      this.holdCue('dodge', now, 220)
    }

    let verticalRunEnergy = 0
    if (this.baseShoulderY === null) {
      this.baseShoulderY = midY
      this.prevMidY = midY
    } else {
      const verticalSpeed = Math.abs(midY - (this.prevMidY ?? midY)) / (scale * deltaSeconds)
      verticalRunEnergy = clamp((verticalSpeed - 0.35) * 0.45, 0, 1)
      this.prevMidY = midY
      // 仅在站立平稳小幅变动时慢速跟踪基线，防止深蹲持续期间把蹲姿学成新站姿
      const curDelta = (this.baseShoulderY - midY) / scale
      if (verticalSpeed < 0.75 && Math.abs(curDelta) < 0.18) {
        this.baseShoulderY += (midY - this.baseShoulderY) * Math.min(1, deltaSeconds * 1.4)
      }
    }

    const deltaY = (this.baseShoulderY - midY) / scale
    const jumpHeight = deltaY > 0.16 ? clamp((deltaY - 0.16) * 5.2, 0, 5.2) : 0
    const crouchDepthWorld = deltaY < -0.14 ? clamp((-deltaY - 0.14) * 3.6, 0, 2.8) : 0
    out.crouchDepth = clamp(crouchDepthWorld / 2.2, 0, 1)
    out.crouching = out.crouchDepth >= 0.36
    out.jumping = jumpHeight >= 0.75
    if (out.crouching) this.holdCue('crouch', now, 160)
    else if (out.jumping) this.holdCue('jump', now, 180)

    // 2. 构建实时全身 3D 骨骼映射包
    const livePose = this.extractLiveBodyPose(worldPts, jumpHeight, crouchDepthWorld, hands)
    out.livePose = livePose
    out.tracking = true
    out.coverage = livePose.coverage
    out.hintKey = 'hintReady'

    // 3. 抬腿飞踢检测
    if (livePose.coverage === 'full') {
      this.detectKick(rawPts, now, deltaSeconds, scale, out)
      if (out.kick) this.holdCue('kick', now, 260)
    }

    // 4. 双肩水平校正 2D 坐标用于手势几何判定
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

    // 实时更新双臂运动学，确保所有姿态分支均可准确获知当前手速（防抱架误触防御的关键）
    this.updateWristKinematics(pts, worldPts, now, deltaSeconds, scale, armScale)

    const armAgitation = this.sampleStruggleAgitation()
    const instantStruggle = clamp(armAgitation * 0.8 + verticalRunEnergy * 0.45, 0, 1)
    this.smoothStruggle +=
      (instantStruggle - this.smoothStruggle) * -Math.expm1(-12 * deltaSeconds)
    out.strugglePower = this.smoothStruggle

    // 单手高举神光棒变身检测
    const nose = pts[0]
    const centerY = (ls.y + rs.y) * 0.5
    const headTopY =
      isVisible(nose, 0.28) && nose.y < centerY - scale * 0.16
        ? nose.y - scale * 0.28
        : centerY - scale * 0.58

    const leftRaisedHigh = isVisible(lw, 0.24) && lw.y < headTopY - scale * 0.12
    const rightRaisedHigh = isVisible(rw, 0.24) && rw.y < headTopY - scale * 0.12
    const isTransformPose = leftRaisedHigh || rightRaisedHigh
    const transformElapsed = this.transformHold.update(isTransformPose, now)
    if (isTransformPose || this.transformHold.isRecent(now)) {
      out.transformProgress = clamp(transformElapsed / 520, 0, 1)
      if (out.transformProgress >= 1 && !this.transformFired) {
        out.transformTrigger = true
        this.transformFired = true
      }
      if (out.transformProgress > 0.25) this.holdCue('transform', now, 160)
    } else {
      this.transformFired = false
    }

    const elbowsVisible = isVisible(le, 0.25) && isVisible(re, 0.25)
    const elbowSpanRaw = elbowsVisible ? Math.abs(le.x - re.x) / scale : 0
    const elbowsAtShoulderLevel =
      elbowsVisible &&
      Math.abs(le.y - centerY) < scale * 0.42 &&
      Math.abs(re.y - centerY) < scale * 0.42
    const elbowsWideSpread = elbowsAtShoulderLevel && elbowSpanRaw > 1.72

    if (!elbowsVisible || !isVisible(lw, 0.2) || !isVisible(rw, 0.2)) {
      this.beamHold.reset()
      this.typeHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.guardSince = null
      this.prevGuardActive = false
      const partialSpreadElapsed = this.spreadHold.update(elbowsWideSpread, now)
      if (elbowsWideSpread || this.spreadHold.isRecent(now)) {
        out.isSpreading = elbowsWideSpread
        out.spreadProgress = clamp(partialSpreadElapsed / 400, 0, 1)
        this.holdCue('spread', now, 150)
      }
      if (!elbowsWideSpread && armScale > 0) {
        this.evaluatePunchFromKinematics(pts, now, scale, livePose, out)
      }
      out.activeCue = now < this.lastCueUntil ? this.lastCue : out.activeCue
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
    const inChestZone = avgWristY > centerY - scale * 0.92 && avgWristY < centerY + scale * 1.75
    const forearmsCross = segmentsCross(le, lw, re, rw)
    const crossedWrists = (lw.x - rw.x) * (ls.x - rs.x) < 0

    // 招式 S：双臂水平展翼蓄力（T 字平展）
    const wristSpan = Math.abs(lw.x - rw.x) / scale
    const elbowSpan = elbowSpanRaw
    const wristsShoulderBand =
      Math.abs(lw.y - centerY) < scale * 0.58 && Math.abs(rw.y - centerY) < scale * 0.58
    const isSpreadPose =
      elbowsAtShoulderLevel &&
      elbowSpan > 1.52 &&
      wristSpan > 2.2 &&
      wristSpan > elbowSpan + 0.4 &&
      wristsShoulderBand &&
      !crossedWrists &&
      !forearmsCross
    const spreadElapsed = this.spreadHold.update(isSpreadPose, now)
    if (isSpreadPose || this.spreadHold.isRecent(now)) {
      out.isSpreading = isSpreadPose
      out.spreadProgress = clamp(spreadElapsed / 380, 0, 1)
      this.holdCue('spread', now, 150)
    }

    // 招式 B：必杀光线优先于护盾判定！经典 L / 十字(+) 手势：一臂竖直向上(>50°)，一臂近水平横置(<40°)，即使双前臂相交也绝不被误吞成蓝盾！
    const forearmGap =
      Math.min(
        segmentDistance(lw, re, rw),
        segmentDistance(rw, le, lw),
        segmentDistance(le, re, rw),
        segmentDistance(re, le, lw),
      ) / scale
    const leftUpward = angles[0]! > 50 && lw.y < le.y - scale * 0.1
    const rightUpward = angles[1]! > 50 && rw.y < re.y - scale * 0.1
    const leftFlat = angles[0]! < 40
    const rightFlat = angles[1]! < 40
    const isClassicLOrCross = (leftUpward && rightFlat) || (rightUpward && leftFlat)
    const beamSide: 'left' | 'right' = leftUpward && !rightUpward ? 'left' : 'right'
    out.beamArmSide = beamSide
    livePose.beamArmSide = beamSide

    const isBeamPose =
      isClassicLOrCross &&
      maxAngle - minAngle > 24 &&
      (forearmGap < 0.92 || forearmsCross) &&
      inChestZone

    const beamElapsed = this.beamHold.update(isBeamPose, now)
    const beamRequiredMs = 230
    if (isBeamPose || (beamElapsed > 0 && this.beamHold.isRecent(now))) {
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.guardSince = null
      this.prevGuardActive = false
      out.beamHolding = isBeamPose
      out.beamCharge = clamp(beamElapsed / beamRequiredMs, 0, 1)
      out.hintKey = 'hintBeamCharge'
      this.holdCue('beam', now, 180)
      out.activeCue = 'beam'
      if (out.beamCharge >= 1 && !this.beamFired) {
        out.beamTrigger = true
        this.beamFired = true
        out.hintKey = 'hintBeamFire'
      }
      return out
    } else if (!this.beamHold.isRecent(now)) {
      this.beamFired = false
    }

    // 招式 A：胸前对称 X 双臂交叉防御（与一竖一横的必杀光线彻底分家，且防拳击抱架误触）
    const maxWristSpd = Math.max(this.wristKin[0].speed2D, this.wristKin[1].speed2D)
    const armsCalmForGuard = maxWristSpd < 2.2
    const wristDist = dist2D(lw, rw) / scale
    const symmetricX = Math.abs(angles[0]! - angles[1]!) < 34
    const strictCrossGuard =
      crossedWrists &&
      forearmsCross &&
      symmetricX &&
      inChestZone &&
      angles[0]! > 28 &&
      angles[0]! < 82 &&
      angles[1]! > 28 &&
      angles[1]! < 82
    // 双臂贴胸紧合竖盾（双手腕贴近且明显高于手肘，彻底区分拳击抱架）
    const tightShieldGuard =
      armsCalmForGuard &&
      wristDist < 0.28 &&
      Math.abs((lw.x + rw.x) * 0.5 - midX) < scale * 0.42 &&
      inChestZone &&
      angles[0]! > 50 &&
      angles[1]! > 50 &&
      lw.y < le.y - scale * 0.24 &&
      rw.y < re.y - scale * 0.24
    const isGuardPose = strictCrossGuard || tightShieldGuard

    if (isGuardPose) {
      this.beamHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      if (this.guardSince === null) this.guardSince = now
      out.guard = now - this.guardSince >= 45
      out.guardJustStarted = out.guard && !this.prevGuardActive
      this.prevGuardActive = out.guard
      out.hintKey = out.guard ? 'hintGuardActive' : 'hintGuardPrep'
      this.holdCue('guard', now, 140)
      out.activeCue = 'guard'
      return out
    }
    this.guardSince = null
    this.prevGuardActive = false

    // 招式 A2：双手交叉举过头顶 0.8s 切换形态（迪迦 / 戴拿）
    const elbowsHigh = le.y < centerY - scale * 0.22 && re.y < centerY - scale * 0.22
    const wristsAboveHead = lw.y < headTopY && rw.y < headTopY
    const wristsCloseOrCrossed =
      (lw.x - rw.x) * (ls.x - rs.x) < 0 || Math.abs(lw.x - rw.x) < scale * 0.52
    const isTypePose = canChangeForm && elbowsHigh && wristsAboveHead && wristsCloseOrCrossed

    const typeElapsed = this.typeHold.update(isTypePose, now)
    if (isTypePose || this.typeHold.isRecent(now)) {
      out.typeCharge = clamp(typeElapsed / 820, 0, 1)
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
        out.activeCue = 'transform'
        return out
      }
      return out
    }
    this.typeFired = false

    // 招式 C：光轮斩（单手高举凝聚 → 发力向下/向前挥劈）
    for (let side = 0; side < 2; side++) {
      const wrist = side === 0 ? lw : rw
      const shoulder = side === 0 ? ls : rs
      const sideName: 'left' | 'right' = side === 0 ? 'left' : 'right'
      const relX = (wrist.x - shoulder.x) / scale
      const relY = (wrist.y - shoulder.y) / scale
      const relZ = (wrist.z - shoulder.z) / scale
      const isHigh = wrist.y < headTopY && angles[side]! > 44
      const kin = this.wristKin[side]!

      const armed = this.discArmed[side]
      if (armed) {
        if (now - armed.time > 1800) {
          this.discArmed[side] = null
          this.discRaiseStart[side] = null
          continue
        }
        const drop = relY - armed.relY
        const forward = armed.relZ - relZ
        const outward = (relX - armed.relX) * (shoulder.x < midX ? -1 : 1)
        const slashFast =
          kin.vy2 > 1.35 ||
          kin.speed2D > 1.75 ||
          kin.forwardVel3D > 0.85 ||
          (now - kin.peakAccel2DAt <= 190 && kin.peakAccel2D > 7.5)
        out.discSide = sideName
        out.discCharge = 1
        out.hintKey = 'hintDiscThrow'
        this.holdCue('disc', now, 150)
        if (drop > 0.24 && (forward > 0.02 || outward > 0.18 || drop > 0.42)) {
          if (slashFast) {
            out.discTrigger = sideName
            out.hintKey = 'hintDiscFire'
            this.discArmed = [null, null]
            this.discRaiseStart = [null, null]
            out.activeCue = 'disc'
            return out
          }
          if (drop > 0.68) {
            this.discArmed[side] = null
            this.discRaiseStart[side] = null
          }
        }
        if (isHigh && relY < armed.relY) {
          armed.relY = relY
        }
      } else if (isHigh) {
        if (this.discRaiseStart[side] === null) this.discRaiseStart[side] = now
        const progress = clamp((now - this.discRaiseStart[side]!) / 210, 0, 1)
        out.discSide = sideName
        out.discCharge = progress
        out.hintKey = 'hintDiscCharge'
        this.holdCue('disc', now, 150)
        out.activeCue = 'disc'
        if (progress >= 1) {
          this.discArmed[side] = { time: now, relX, relY, relZ }
        }
        return out
      } else {
        this.discRaiseStart[side] = null
      }
    }

    // 招式 D：全向 5 种打击意图判定（直拳 / 摆拳 / 上勾 / 推掌 / 手刀劈）
    if (!isSpreadPose && armScale > 0) {
      this.evaluatePunchFromKinematics(pts, now, scale, livePose, out)
    }

    out.activeCue = now < this.lastCueUntil ? this.lastCue : out.activeCue
    return out
  }

  private sampleStruggleAgitation(): number {
    const s = Math.max(this.wristKin[0].speed2D, this.wristKin[1].speed2D)
    const avg = (this.wristKin[0].speed2D + this.wristKin[1].speed2D) * 0.5
    return clamp(((s * 0.6 + avg * 0.4) - 1.5) / 3.6, 0, 1)
  }

  private extractLiveBodyPose(
    w: Vec3[],
    jumpHeight: number,
    crouchDepth: number,
    hands?: HandLandmarksInput | null,
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
      -0.46,
      0.46,
    )
    const torsoPitch = clamp(
      Math.atan2(-torsoDir.z, Math.max(0.25, torsoDir.y)) * 0.8,
      -0.38,
      0.52,
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
        headRoll = clamp(Math.atan2(earAxis.y, Math.abs(earAxis.x) + 0.1) - torsoRoll, -0.38, 0.38)
        headYaw = clamp(Math.atan2(-earAxis.z, Math.max(0.2, earAxis.x)) - torsoYaw, -0.58, 0.58)
      }
      if (isVisible(nose, 0.36)) {
        const earMid = avgVec(earL, earR)
        const noseDir = mpDirToWorld(earMid, nose, 0.82)
        if (noseDir) {
          headPitch = clamp(
            Math.atan2(-noseDir.y, Math.abs(noseDir.z) + 0.35) * 0.7,
            -0.34,
            0.34,
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

    const fingersL = extractHandFingers(hands?.leftWorld, hands?.left, true)
    const fingersR = extractHandFingers(hands?.rightWorld, hands?.right, false)

    const upperArmL = dirIfVisible(11, 13, 0.34, 0.28)
    const lowerArmL = dirIfVisible(13, 15, 0.28, 0.22)
    // 无手部模型时不再使用高噪 Pose 食指点，直接让手掌顺沿前臂自然延展避免甩腕
    const handL = fingersL?.handDir ?? lowerArmL
    const upperArmR = dirIfVisible(12, 14, 0.34, 0.28)
    const lowerArmR = dirIfVisible(14, 16, 0.28, 0.22)
    const handR = fingersR?.handDir ?? lowerArmR

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
      fingersL,
      fingersR,
      beamArmSide: 'right',
    }
  }

  private detectKick(pts: Vec3[], now: number, dt: number, scale: number, out: GestureSnapshot) {
    const velAlpha = 1 - Math.exp(-dt / 0.025)
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
        if (upAccel > kin.peakUpAccel || now - kin.peakUpAccelAt > 170) {
          kin.peakUpAccel = Math.max(0, upAccel)
          kin.peakUpAccelAt = now
        }
      }
      kin.prevAnkleRelY = ankleRelY
      kin.prevKneeRelY = kneeRelY

      const kneeRaised = kneeRelY > -0.74
      const ankleRaised = ankleRelY > -1.42
      const isKickHigh = kneeRaised && ankleRaised
      const hasKickBurst =
        kin.upVel > 1.55 && now - kin.peakUpAccelAt <= 190 && kin.peakUpAccel > 9.0

      if (isKickHigh && !kin.wasHigh && hasKickBurst && now - this.kickLast[side]! > 440) {
        this.kickLast[side] = now
        out.kick = side === 0 ? 'left' : 'right'
        out.hintKey = 'hintKick'
      }
      kin.wasHigh = isKickHigh
    }
  }

  /** 每帧持续更新左右腕动力学（确保任何分支切换回来都没有跳变基线） */
  private updateWristKinematics(
    pts2D: Vec3[],
    pts3D: Vec3[],
    now: number,
    dt: number,
    scale2D: number,
    scale3D: number,
  ) {
    // 较短的 τ=18ms 避免 30fps 摄像头下的短促直拳被削峰
    const velAlpha = 1 - Math.exp(-dt / 0.018)
    const ACCEL_WINDOW_MS = 155
    const STROKE_WINDOW_MS = 165

    for (let side = 0; side < 2; side++) {
      const s2 = pts2D[side === 0 ? 11 : 12]!
      const w2 = pts2D[side === 0 ? 15 : 16]
      const s3 = pts3D[side === 0 ? 11 : 12]
      const e3 = pts3D[side === 0 ? 13 : 14]
      const w3 = pts3D[side === 0 ? 15 : 16]
      const kin = this.wristKin[side]!

      if (
        scale3D <= 1e-4 ||
        !isVisible(w2, 0.2) ||
        !isVisible(s3, 0.3) ||
        !isVisible(e3, 0.26) ||
        !isVisible(w3, 0.2)
      ) {
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

      const lastSampleT = kin.trail.length > 0 ? kin.trail[kin.trail.length - 1]!.t : -Infinity
      if (now - lastSampleT > 220) {
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

        const accel2D = (kin.speed2D - prevSpeed2D) / dt
        const upAccel = (prevVy2 - kin.vy2) / dt
        const downAccel = (kin.vy2 - prevVy2) / dt
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
        if (downAccel >= kin.peakDownAccel || now - kin.peakDownAccelAt > ACCEL_WINDOW_MS) {
          kin.peakDownAccel = Math.max(0, downAccel)
          kin.peakDownAccelAt = now
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

      const isRetracting = kin.forwardVel3D < -0.3 || kin.radialVel2D < -0.45
      if ((kin.speed2D < 1.2 && kin.forwardVel3D < 0.45 && kin.elbowVel < 70) || isRetracting) {
        this.punchPeakLock[side] = false
      }
    }
  }

  /**
   * 针对真实 24~30fps 摄像头优化的全向打击意图判定：
   * 融合 2D/3D 有效行程、肘部伸展速度与挥击速度，确保正对镜头直拳、横摆拳、上勾拳与手刀一打必出且慢动绝不误触
   */
  private evaluatePunchFromKinematics(
    pts2D: Vec3[],
    now: number,
    scale2D: number,
    livePose: LiveBodyPose,
    out: GestureSnapshot,
  ) {
    let bestSide: 'left' | 'right' | null = null
    let bestStyle: PunchStyle = 'jab'
    let bestPower = 0.65
    let bestHeight: StrikeHeight = 'mid'
    let bestScore = -Infinity

    const ACCEL_WINDOW_MS = 185

    for (let side = 0; side < 2; side++) {
      const s2 = pts2D[side === 0 ? 11 : 12]!
      const w2 = pts2D[side === 0 ? 15 : 16]
      const kin = this.wristKin[side]!
      if (!isVisible(w2, 0.2) || kin.trail.length < 2 || kin.prevElbowDeg === null) continue

      const relX2 = (w2.x - s2.x) / scale2D
      const relY2 = (w2.y - s2.y) / scale2D
      const latest = kin.trail[kin.trail.length - 1]!
      const oldest = kin.trail[0]!

      const stroke2D = Math.hypot(latest.x2 - oldest.x2, latest.y2 - oldest.y2)
      const stroke3D = Math.hypot(
        latest.x3 - oldest.x3,
        latest.y3 - oldest.y3,
        latest.z3 - oldest.z3,
      )
      const forwardStroke3D = oldest.z3 - latest.z3
      const horizStroke2D = Math.abs(latest.x2 - oldest.x2)
      const upStroke2D = oldest.y2 - latest.y2
      const downStroke2D = latest.y2 - oldest.y2
      const elbowDeg = kin.prevElbowDeg

      const inStrikeZone = relY2 > -0.95 && relY2 < 1.32
      const cooldownOk = now - this.punchLast[side]! > 180 && !this.punchPeakLock[side]
      if (!cooldownOk || !inStrikeZone) continue

      // 宽松且稳健的爆发门控（适配 24~30fps 视频离散采样，避免被离散帧削峰吞拳）
      const hasRecentFwdAccel =
        now - kin.peakFwdAccelAt <= ACCEL_WINDOW_MS && kin.peakFwdAccel >= 4.2
      const hasRecent3DAccel =
        now - kin.peakSpeed3DAccelAt <= ACCEL_WINDOW_MS && kin.peakSpeed3DAccel >= 5.2
      const hasRecent2DAccel =
        now - kin.peakAccel2DAt <= ACCEL_WINDOW_MS && kin.peakAccel2D >= 6.5
      const hasRecentUpAccel =
        now - kin.peakUpAccelAt <= ACCEL_WINDOW_MS && kin.peakUpAccel >= 6.5
      const hasRecentDownAccel =
        now - kin.peakDownAccelAt <= ACCEL_WINDOW_MS && kin.peakDownAccel >= 7.5
      const hasRecentElbowAccel =
        now - kin.peakElbowAccelAt <= ACCEL_WINDOW_MS && kin.peakElbowAccel >= 420

      const notDroppingSlowly = kin.vy2 < 1.85
      const notPullingBack = kin.forwardVel3D > -0.55

      const fingers = side === 0 ? livePose.fingersL : livePose.fingersR
      const handIsOpenFlat =
        !!fingers &&
        (fingers.index + fingers.mid + fingers.ring + fingers.pinky) * 0.25 < 0.36

      // 通道 1：正对镜头直拳 / 推掌（3D 前突速度 OR 肘部爆发伸直 OR 径向弹出三路协同，告别正打直拳哑火）
      const isForwardThrust =
        elbowDeg > 88 &&
        ((forwardStroke3D > 0.065 &&
          stroke3D > 0.13 &&
          kin.forwardVel3D > 0.72 &&
          (kin.speed3D > 1.05 || hasRecentFwdAccel || hasRecent3DAccel)) ||
          (kin.elbowVel > 115 &&
            elbowDeg > 102 &&
            (kin.forwardVel3D > 0.32 || kin.radialVel2D > 0.85 || hasRecentElbowAccel)) ||
          (kin.radialVel2D > 1.45 && stroke2D > 0.2 && kin.forwardVel3D > 0.25 && hasRecent2DAccel))

      // 通道 2：横摆勾拳（必须水平主行程主导，避免被轻微上扬误抢为上勾拳）
      const isSwingHook =
        notDroppingSlowly &&
        notPullingBack &&
        kin.speed2D > 1.75 &&
        Math.abs(kin.vx2) > 1.25 &&
        horizStroke2D > 0.18 &&
        Math.abs(kin.vx2) >= Math.abs(kin.vy2) * 0.85 &&
        (hasRecent2DAccel || kin.speed2D > 2.35) &&
        elbowDeg > 45

      // 通道 3：上勾升龙拳（必须真实向上主行程主导，杜绝横摆拳误判成上勾拳）
      const isUppercut =
        kin.speed2D > 1.75 &&
        kin.vy2 < -1.55 &&
        upStroke2D > 0.18 &&
        -kin.vy2 > Math.abs(kin.vx2) * 0.9 &&
        (hasRecentUpAccel || kin.vy2 < -2.1) &&
        relY2 < 0.65

      // 通道 4：奥特手刀斜劈斩（高速斜下劈，仍过滤自然垂手）
      const isChop =
        notPullingBack &&
        downStroke2D > 0.28 &&
        kin.vy2 > 2.05 &&
        kin.vy2 > Math.abs(kin.vx2) * 0.85 &&
        (hasRecentDownAccel || kin.vy2 > 2.65) &&
        Math.abs(kin.vx2) > 0.65 &&
        elbowDeg > 92

      if (isForwardThrust || isSwingHook || isUppercut || isChop) {
        let style: PunchStyle = 'jab'
        if (isUppercut) style = 'uppercut'
        else if (isChop) style = 'chop'
        else if (isForwardThrust && handIsOpenFlat) style = 'palm'
        else if (isSwingHook && (!isForwardThrust || Math.abs(kin.vx2) > kin.forwardVel3D * 1.35)) {
          style = 'hook'
        } else {
          style = 'jab'
        }

        const power = clamp(
          (kin.speed2D * 0.26 + Math.max(0, kin.forwardVel3D) * 0.42 + stroke3D * 0.75) * 0.62,
          0.48,
          1.0,
        )
        const height: StrikeHeight =
          style === 'uppercut' || relY2 < -0.18 ? 'high' : relY2 > 0.45 ? 'low' : 'mid'

        const score =
          kin.speed2D * 0.5 +
          Math.max(0, kin.forwardVel3D) * 0.85 +
          Math.max(0, kin.elbowVel) * 0.004 +
          kin.peakAccel2D * 0.035
        if (score > bestScore) {
          bestScore = score
          bestSide = side === 0 ? 'left' : 'right'
          bestStyle = style
          bestPower = power
          bestHeight = height
        }
      }
    }

    if (bestSide) {
      const idx = bestSide === 'left' ? 0 : 1
      this.punchLast[idx] = now
      this.punchPeakLock[idx] = true
      out.punch = bestSide
      out.punchStyle = bestStyle
      out.punchPower = bestPower
      out.punchHeight = bestHeight
      out.hintKey = 'hintPunch'
      this.holdCue(bestSide === 'left' ? 'punch-l' : 'punch-r', now, 240)
    }
  }
}
