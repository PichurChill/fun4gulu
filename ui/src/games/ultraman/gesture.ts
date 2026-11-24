import type { GestureSnapshot, LiveBodyPose, PoseLandmark, Vec3Like } from './types'

interface Vec3 {
  x: number
  y: number
  z: number
  v: number
}

interface PunchReadyState {
  time: number
  relX: number
  relY: number
  relZ: number
  angle: number
}

interface DiscArmedState {
  time: number
  relX: number
  relY: number
  relZ: number
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const dist2D = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y)

function isVisible(p: Vec3 | undefined, threshold = 0.4): p is Vec3 {
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

  constructor(graceMs = 190) {
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
 * 奥特曼全身体感校准 + 高灵敏度招式识别器：
 * 1) 稳态自适应肩高基准（彻底解决初帧弯腰/后退导致角色永久悬空问题）
 * 2) 三维拳速 + 冲程 + 肘角融合出拳识别（带回撤防重锁，直拳/勾拳干脆跟手）
 * 3) 精准防御首帧捕捉、1.1s 快速形态切换、光线对波持续手势输出
 */
export class UltraGestureRecognizer {
  private centerOffset = 0
  private lastMidXRatio = 0.5
  private baseShoulderY: number | null = null
  private prevMidY: number | null = null
  private lastFrameTime: number | null = null
  private guardSince: number | null = null
  private prevGuardActive = false
  private beamHold = new SmoothHold(210)
  private beamFired = false
  private discRaiseStart: [number | null, number | null] = [null, null]
  private discArmed: [DiscArmedState | null, DiscArmedState | null] = [null, null]
  private punchReady: [PunchReadyState | null, PunchReadyState | null] = [null, null]
  private prevWristRel: [{ x: number; y: number; z: number } | null, { x: number; y: number; z: number } | null] = [
    null,
    null,
  ]
  private punchRetracted: [boolean, boolean] = [true, true]
  private punchLast: [number, number] = [-Infinity, -Infinity]
  private kickLast: [number, number] = [-Infinity, -Infinity]
  private kickWasHigh: [boolean, boolean] = [false, false]
  private typeHold = new SmoothHold(240)
  private typeFired = false
  private smoothLean = 0

  public reset() {
    this.centerOffset = 0
    this.lastMidXRatio = 0.5
    this.baseShoulderY = null
    this.prevMidY = null
    this.lastFrameTime = null
    this.guardSince = null
    this.prevGuardActive = false
    this.beamHold.reset()
    this.beamFired = false
    this.discRaiseStart = [null, null]
    this.discArmed = [null, null]
    this.punchReady = [null, null]
    this.prevWristRel = [null, null]
    this.punchRetracted = [true, true]
    this.punchLast = [-Infinity, -Infinity]
    this.kickLast = [-Infinity, -Infinity]
    this.kickWasHigh = [false, false]
    this.typeHold.reset()
    this.typeFired = false
    this.smoothLean = 0
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
      lean: this.smoothLean * 0.85,
      guard: false,
      guardJustStarted: false,
      punch: null,
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
      mirroredCenterX: 1 - this.lastMidXRatio,
      livePose: null,
      hintKey: 'hintStandCenter',
    }

    if (
      !landmarks ||
      landmarks.length < 33 ||
      width <= 0 ||
      height <= 0 ||
      (this.lastFrameTime !== null && (now < this.lastFrameTime || now - this.lastFrameTime > 1200))
    ) {
      this.reset()
      this.lastFrameTime = now
      return out
    }
    const deltaSeconds = this.lastFrameTime === null ? 0 : clamp((now - this.lastFrameTime) / 1000, 0.001, 0.12)
    this.lastFrameTime = now

    const rawPts: Vec3[] = landmarks.map((lm) => ({
      x: lm.x * width,
      y: lm.y * height,
      z: (lm.z ?? 0) * width,
      v: lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1 ? (lm.visibility ?? 1) : 0,
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
    if (!isVisible(lsRaw, 0.4) || !isVisible(rsRaw, 0.4)) {
      this.reset()
      return out
    }

    const shoulderWidth = dist2D(lsRaw, rsRaw)
    if (shoulderWidth < width * 0.042) {
      return out
    }
    const scale = Math.max(shoulderWidth, height * 0.07)

    // 1. 站位水平与自适应垂直基准
    const midX = (lsRaw.x + rsRaw.x) * 0.5
    const midY = (lsRaw.y + rsRaw.y) * 0.5
    this.lastMidXRatio = midX / width
    out.mirroredCenterX = 1 - this.lastMidXRatio

    const offsetFromCenter = this.lastMidXRatio - (0.5 + this.centerOffset)
    const rawLean = clamp(-offsetFromCenter / 0.27, -1, 1)
    const lean =
      laneCenter === undefined ? rawLean : clamp((laneCenter - midX / width) / 0.14, -1, 1)
    this.smoothLean += (lean - this.smoothLean) * -Math.expm1(-14 * deltaSeconds)
    out.lean = Math.abs(this.smoothLean) < 0.055 ? 0 : this.smoothLean

    if (this.baseShoulderY === null) {
      this.baseShoulderY = midY
      this.prevMidY = midY
    } else {
      const verticalSpeed = Math.abs(midY - (this.prevMidY ?? midY)) / (scale * deltaSeconds)
      this.prevMidY = midY
      // 平稳站立/坐姿时慢速校准基准肩高，避免初帧弯腰点鼠标后整局悬空
      if (verticalSpeed < 0.85) {
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

    // 3. 检测抬腿飞踢
    if (livePose.coverage === 'full') {
      this.detectKick(rawPts, now, scale, out)
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

    if (
      !isVisible(le, 0.3) ||
      !isVisible(re, 0.3) ||
      !isVisible(lw, 0.24) ||
      !isVisible(rw, 0.24)
    ) {
      this.beamHold.reset()
      this.typeHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.guardSince = null
      this.prevGuardActive = false
      if (armScale > 0) this.detectPunch(worldPts, now, deltaSeconds, armScale, out)
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
    const centerY = (ls.y + rs.y) * 0.5
    const avgWristY = (lw.y + rw.y) * 0.5
    const inChestZone = avgWristY > centerY - scale * 0.9 && avgWristY < centerY + scale * 1.8
    const forearmsCross = segmentsCross(le, lw, re, rw)
    const crossedWrists = (lw.x - rw.x) * (ls.x - rs.x) < 0

    // 招式 A：胸前 X 双臂交叉防御（含精准格挡起手帧标记）
    const isGuardPose =
      crossedWrists &&
      inChestZone &&
      angles[0]! > 22 &&
      angles[0]! < 80 &&
      angles[1]! > 22 &&
      angles[1]! < 80 &&
      Math.abs(angles[0]! - angles[1]!) < 32 &&
      forearmsCross

    if (isGuardPose) {
      this.beamHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.punchReady = [null, null]
      if (this.guardSince === null) this.guardSince = now
      out.guard = now - this.guardSince >= 80
      out.guardJustStarted = out.guard && !this.prevGuardActive
      this.prevGuardActive = out.guard
      out.hintKey = out.guard ? 'hintGuardActive' : 'hintGuardPrep'
      return out
    }
    this.guardSince = null
    this.prevGuardActive = false

    // 招式 A2：双手交叉举过头顶 1.1 秒快速切换形态（迪迦 / 戴拿）
    const nose = pts[0]
    const headTopY =
      isVisible(nose, 0.3) && nose.y < centerY - scale * 0.18
        ? nose.y - scale * 0.32
        : centerY - scale * 0.62
    const elbowsHigh = le.y < centerY - scale * 0.24 && re.y < centerY - scale * 0.24
    const wristsAboveHead = lw.y < headTopY && rw.y < headTopY
    const wristsCloseOrCrossed =
      (lw.x - rw.x) * (ls.x - rs.x) < 0 || Math.abs(lw.x - rw.x) < scale * 0.48
    const isTypePose = canChangeForm && elbowsHigh && wristsAboveHead && wristsCloseOrCrossed

    const typeElapsed = this.typeHold.update(isTypePose, now)
    if (isTypePose || this.typeHold.isRecent(now)) {
      out.typeCharge = clamp(typeElapsed / 1100, 0, 1)
      out.hintKey = 'hintTypeCharge'
      if (out.typeCharge >= 1 && !this.typeFired) {
        out.typeTrigger = true
        this.typeFired = true
        out.hintKey = 'hintTypeSwitch'
      }
      if (isTypePose) {
        this.punchReady = [null, null]
        this.discRaiseStart = [null, null]
        this.discArmed = [null, null]
        this.beamHold.reset()
        return out
      }
      return out
    }
    this.typeFired = false

    // 招式 B：必杀光线（经典 L 字或十字 + 姿势）
    const forearmGap =
      Math.min(
        segmentDistance(lw, re, rw),
        segmentDistance(rw, le, lw),
        segmentDistance(le, re, rw),
        segmentDistance(re, le, lw),
      ) / scale
    const leftUpward = angles[0]! > 48 && lw.y < le.y - scale * 0.16
    const rightUpward = angles[1]! > 48 && rw.y < re.y - scale * 0.16
    const oneUpward = leftUpward || rightUpward
    const beamSide: 'left' | 'right' = leftUpward && !rightUpward ? 'left' : 'right'
    out.beamArmSide = beamSide
    livePose.beamArmSide = beamSide

    const isBeamPose =
      !this.discArmed[0] &&
      !this.discArmed[1] &&
      minAngle < 42 &&
      maxAngle > 48 &&
      maxAngle - minAngle > 28 &&
      forearmGap < 0.64 &&
      inChestZone &&
      oneUpward

    const beamElapsed = this.beamHold.update(isBeamPose, now)
    const beamRequiredMs = 340
    if (isBeamPose || (beamElapsed > 0 && this.beamHold.isRecent(now))) {
      this.punchReady = [null, null]
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

    // 招式 C：光轮斩（单手高举凝聚 → 向下/向前挥劈）
    for (let side = 0; side < 2; side++) {
      const wrist = side === 0 ? lw : rw
      const shoulder = side === 0 ? ls : rs
      const sideName: 'left' | 'right' = side === 0 ? 'left' : 'right'
      const relX = (wrist.x - shoulder.x) / scale
      const relY = (wrist.y - shoulder.y) / scale
      const relZ = (wrist.z - shoulder.z) / scale
      const isHigh = wrist.y < headTopY && angles[side]! > 46

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
        out.discSide = sideName
        out.discCharge = 1
        out.hintKey = 'hintDiscThrow'
        if (drop > 0.34 && (forward > 0.06 || outward > 0.34 || drop > 0.65)) {
          out.discTrigger = sideName
          out.hintKey = 'hintDiscFire'
          this.discArmed = [null, null]
          this.discRaiseStart = [null, null]
          this.punchReady = [null, null]
          return out
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
        this.punchReady = [null, null]
        return out
      } else {
        this.discRaiseStart[side] = null
      }
    }

    // 招式 D：左右挥拳（速度 + 冲程融合识别）
    if (armScale > 0) this.detectPunch(worldPts, now, deltaSeconds, armScale, out)
    return out
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
    const hasHips = isVisible(lh, 0.35) && isVisible(rh, 0.35)
    const hipMid = hasHips
      ? avgVec(lh, rh)
      : { x: shoulderMid.x, y: shoulderMid.y + 0.45, z: shoulderMid.z, v: 0.5 }

    const torsoDir = mpDirToWorld(hipMid, shoulderMid, 0.75) ?? { x: 0, y: 1, z: 0 }
    const shoulderAxis = mpDirToWorld(ls, rs, 0.9) ?? { x: 1, y: 0, z: 0 }

    const torsoRoll = clamp(
      Math.atan2(shoulderAxis.y, Math.abs(shoulderAxis.x) + 0.15) * 0.9,
      -0.52,
      0.52,
    )
    const torsoPitch = clamp(
      Math.atan2(-torsoDir.z, Math.max(0.25, torsoDir.y)) * 0.85,
      -0.45,
      0.58,
    )
    const torsoYaw = clamp(
      Math.atan2(-shoulderAxis.z, Math.max(0.2, shoulderAxis.x)) * 0.9,
      -0.78,
      0.78,
    )

    let headYaw = 0
    let headPitch = 0
    let headRoll = 0
    const nose = w[0]
    const earL = w[7]
    const earR = w[8]
    if (isVisible(earL, 0.35) && isVisible(earR, 0.35)) {
      const earAxis = mpDirToWorld(earL, earR, 0.85)
      if (earAxis) {
        headRoll = clamp(Math.atan2(earAxis.y, Math.abs(earAxis.x) + 0.1) - torsoRoll, -0.45, 0.45)
        headYaw = clamp(Math.atan2(-earAxis.z, Math.max(0.2, earAxis.x)) - torsoYaw, -0.65, 0.65)
      }
      if (isVisible(nose, 0.4)) {
        const earMid = avgVec(earL, earR)
        const noseDir = mpDirToWorld(earMid, nose, 0.85)
        if (noseDir) {
          headPitch = clamp(
            Math.atan2(-noseDir.y, Math.abs(noseDir.z) + 0.35) * 0.75,
            -0.4,
            0.4,
          )
        }
      }
    }

    const dirIfVisible = (aIdx: number, bIdx: number, thA = 0.32, thB = 0.28): Vec3Like | null => {
      const a = w[aIdx]
      const b = w[bIdx]
      if (!isVisible(a, thA) || !isVisible(b, thB)) return null
      return mpDirToWorld(a, b, 0.95)
    }

    const upperArmL = dirIfVisible(11, 13, 0.38, 0.32)
    const lowerArmL = dirIfVisible(13, 15, 0.32, 0.25)
    const handL = dirIfVisible(15, 19, 0.28, 0.22)
    const upperArmR = dirIfVisible(12, 14, 0.38, 0.32)
    const lowerArmR = dirIfVisible(14, 16, 0.32, 0.25)
    const handR = dirIfVisible(16, 20, 0.28, 0.22)

    const thighL = hasHips ? dirIfVisible(23, 25, 0.45, 0.45) : null
    const shinL = thighL ? dirIfVisible(25, 27, 0.45, 0.42) : null
    const thighR = hasHips ? dirIfVisible(24, 26, 0.45, 0.45) : null
    const shinR = thighR ? dirIfVisible(26, 28, 0.45, 0.42) : null
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

  private detectKick(pts: Vec3[], now: number, scale: number, out: GestureSnapshot) {
    for (let side = 0; side < 2; side++) {
      const hip = pts[side === 0 ? 23 : 24]
      const knee = pts[side === 0 ? 25 : 26]
      const ankle = pts[side === 0 ? 27 : 28]
      if (!isVisible(hip, 0.44) || !isVisible(knee, 0.44) || !isVisible(ankle, 0.38)) {
        this.kickWasHigh[side] = false
        continue
      }
      const kneeRaised = hip.y - knee.y > -scale * 0.65
      const ankleRaised = hip.y - ankle.y > -scale * 1.32
      const isKickHigh = kneeRaised && ankleRaised

      if (isKickHigh && !this.kickWasHigh[side] && now - this.kickLast[side]! > 400) {
        this.kickLast[side] = now
        out.kick = side === 0 ? 'left' : 'right'
        out.hintKey = 'hintKick'
      }
      this.kickWasHigh[side] = isKickHigh
    }
  }

  private detectPunch(
    pts: Vec3[],
    now: number,
    dt: number,
    scale: number,
    out: GestureSnapshot,
  ) {
    let bestSide: 'left' | 'right' | null = null
    let bestScore = -Infinity

    for (let side = 0; side < 2; side++) {
      const s = pts[side === 0 ? 11 : 12]
      const e = pts[side === 0 ? 13 : 14]
      const w = pts[side === 0 ? 15 : 16]
      if (!isVisible(s, 0.34) || !isVisible(e, 0.34) || !isVisible(w, 0.25)) {
        this.punchReady[side] = null
        this.prevWristRel[side] = null
        continue
      }

      const angle = elbowAngleDeg(s, e, w)
      const relX = (w.x - s.x) / scale
      const relY = (w.y - s.y) / scale
      const relZ = (w.z - s.z) / scale
      const inStrikeZone = relY > -0.7 && relY < 1.12

      // 计算瞬时向前爆发拳速（MediaPipe 中向镜头前挥拳 relZ 减小，故 forwardVel > 0 为向前出拳）
      const prevW = this.prevWristRel[side]
      const forwardVel = prevW ? (prevW.z - relZ) / dt : 0
      const speed3D = prevW
        ? Math.hypot(relX - prevW.x, relY - prevW.y, relZ - prevW.z) / dt
        : 0
      this.prevWristRel[side] = { x: relX, y: relY, z: relZ }

      // 当手肘收回或向后收拳时解锁回撤标志，防止收拳误判二次出拳
      if (angle < 126 || forwardVel < -0.6) {
        this.punchRetracted[side] = true
      }

      if (angle < 136 && inStrikeZone) {
        const prev = this.punchReady[side]
        if (!prev) {
          this.punchReady[side] = { time: now, relX, relY, relZ, angle }
        } else {
          prev.angle = Math.min(prev.angle, angle)
          if (relZ >= prev.relZ - 0.035) {
            prev.time = now
            if (relZ > prev.relZ) {
              prev.relX = relX
              prev.relY = relY
              prev.relZ = relZ
            }
          }
        }
      }

      const ready = this.punchReady[side]
      const cooldownOk = now - this.punchLast[side]! > 180 && this.punchRetracted[side]

      if (ready) {
        if (!inStrikeZone || now - ready.time > 780) {
          this.punchReady[side] = null
        } else {
          const forward = ready.relZ - relZ
          const lateral = Math.abs(relX - ready.relX)
          const travel = Math.hypot(relX - ready.relX, relY - ready.relY, relZ - ready.relZ)
          const isExtensionStrike =
            angle > 124 &&
            angle - ready.angle > 12 &&
            travel > 0.13 &&
            (forward > 0.06 || (travel > 0.28 && lateral < 0.78))
          const isVelocityJab =
            inStrikeZone &&
            angle > 112 &&
            forwardVel > 1.45 &&
            forward > 0.08 &&
            speed3D > 1.8

          if (cooldownOk && (isExtensionStrike || isVelocityJab)) {
            const score = forward + travel * 0.35 + Math.max(0, forwardVel) * 0.12
            if (score > bestScore) {
              bestScore = score
              bestSide = side === 0 ? 'left' : 'right'
            }
          }
        }
      } else if (cooldownOk && inStrikeZone && angle > 118 && forwardVel > 1.95 && relZ < -0.18) {
        // 连续快速刺拳（手未大曲肘直接前刺爆发）
        const score = forwardVel * 0.2
        if (score > bestScore) {
          bestScore = score
          bestSide = side === 0 ? 'left' : 'right'
        }
      }
    }

    if (bestSide) {
      const idx = bestSide === 'left' ? 0 : 1
      this.punchLast[idx] = now
      this.punchReady[idx] = null
      this.punchRetracted[idx] = false
      out.punch = bestSide
      out.hintKey = 'hintPunch'
    }
  }
}
