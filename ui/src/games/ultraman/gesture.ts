import type { GestureSnapshot, PoseLandmark } from './types'

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

/**
 * 抗抖动持续计时器：容忍短暂单帧关键点抖动，避免小朋友动作断档
 */
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
 * 奥特曼体感动作识别器（支持出拳连击、左右闪避、X交叉防御、举手八分光轮、L/十字哉佩利敖光线）
 */
export class UltraGestureRecognizer {
  private centerX: number | null = null
  private lastFrameTime: number | null = null
  private guardSince: number | null = null
  private beamHold = new SmoothHold(200)
  private beamFired = false
  private discRaiseStart: [number | null, number | null] = [null, null]
  private discArmed: [DiscArmedState | null, DiscArmedState | null] = [null, null]
  private punchReady: [PunchReadyState | null, PunchReadyState | null] = [null, null]
  private punchLast: [number, number] = [-Infinity, -Infinity]
  private smoothLean = 0

  public reset() {
    this.centerX = null
    this.lastFrameTime = null
    this.guardSince = null
    this.beamHold.reset()
    this.beamFired = false
    this.discRaiseStart = [null, null]
    this.discArmed = [null, null]
    this.punchReady = [null, null]
    this.punchLast = [-Infinity, -Infinity]
    this.smoothLean = 0
  }

  public recenter() {
    this.centerX = null
  }

  public update(
    landmarks: PoseLandmark[] | null,
    now: number,
    width = 640,
    height = 480,
  ): GestureSnapshot {
    const out: GestureSnapshot = {
      tracking: false,
      lean: this.smoothLean * 0.85,
      guard: false,
      punch: null,
      discCharge: 0,
      discSide: null,
      discTrigger: null,
      beamCharge: 0,
      beamTrigger: false,
      hintKey: 'hintStandCenter',
    }

    if (
      !landmarks ||
      (this.lastFrameTime !== null && (now < this.lastFrameTime || now - this.lastFrameTime > 1200))
    ) {
      this.reset()
      this.lastFrameTime = now
      return out
    }
    this.lastFrameTime = now

    const pts: Vec3[] = landmarks.map((lm) => ({
      x: lm.x * width,
      y: lm.y * height,
      z: (lm.z ?? 0) * width,
      v: lm.visibility ?? 1,
    }))

    const lsRaw = pts[11]
    const rsRaw = pts[12]
    if (!isVisible(lsRaw, 0.45) || !isVisible(rsRaw, 0.45)) {
      this.guardSince = null
      return out
    }

    // 按双肩连线做水平校正，忽略摄像头歪斜
    const dx = rsRaw.x - lsRaw.x
    const dy = rsRaw.y - lsRaw.y
    const sign = Math.sign(dx) || 1
    const roll = Math.atan2(dy * sign, dx * sign)
    const cos = Math.cos(roll)
    const sin = Math.sin(roll)
    const cx = (lsRaw.x + rsRaw.x) / 2
    const cy = (lsRaw.y + rsRaw.y) / 2
    for (const p of pts) {
      const rx = p.x - cx
      const ry = p.y - cy
      p.x = cx + rx * cos + ry * sin
      p.y = cy - rx * sin + ry * cos
    }

    const ls = pts[11]!
    const rs = pts[12]!
    const shoulderWidth = dist2D(ls, rs)
    if (shoulderWidth < width * 0.05) {
      return out
    }
    const scale = Math.max(shoulderWidth, height * 0.07)

    out.tracking = true
    out.hintKey = 'hintReady'

    // 左右闪避位移（前置镜像：人向右移动，原图 x 减小）
    const midX = (ls.x + rs.x) / 2
    if (this.centerX === null) {
      this.centerX = midX
    } else if (Math.abs(midX - this.centerX) < scale * 0.28) {
      // 站定中心附近时极缓慢跟踪漂移
      this.centerX += (midX - this.centerX) * 0.015
    }
    const rawLean = clamp((-(midX - this.centerX) / scale) * 1.45, -1, 1)
    this.smoothLean += (rawLean - this.smoothLean) * 0.35
    out.lean = Math.abs(this.smoothLean) < 0.08 ? 0 : this.smoothLean

    const le = pts[13]
    const re = pts[14]
    const lw = pts[15]
    const rw = pts[16]

    // 即使只露出单臂也能出拳
    if (
      !isVisible(le, 0.35) ||
      !isVisible(re, 0.35) ||
      !isVisible(lw, 0.28) ||
      !isVisible(rw, 0.28)
    ) {
      this.beamHold.reset()
      this.guardSince = null
      this.detectPunch(pts, now, scale, out)
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
    const centerY = (ls.y + rs.y) / 2
    const avgWristY = (lw.y + rw.y) / 2
    const inChestZone = avgWristY > centerY - scale * 0.85 && avgWristY < centerY + scale * 1.75
    const forearmsCross = segmentsCross(le, lw, re, rw)
    const crossedWrists = (lw.x - rw.x) * (ls.x - rs.x) < 0

    // 1. 胸前 X 双臂交叉防御（优先响应，确保防御及时）
    const isGuardPose =
      crossedWrists &&
      inChestZone &&
      angles[0]! > 25 &&
      angles[0]! < 78 &&
      angles[1]! > 25 &&
      angles[1]! < 78 &&
      Math.abs(angles[0]! - angles[1]!) < 28 &&
      forearmsCross

    if (isGuardPose) {
      this.beamHold.reset()
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
      this.punchReady = [null, null]
      if (this.guardSince === null) this.guardSince = now
      out.guard = now - this.guardSince >= 100
      out.hintKey = out.guard ? 'hintGuardActive' : 'hintGuardPrep'
      return out
    }
    this.guardSince = null

    // 2. 哉佩利敖光线（经典 L 字或十字 + 姿势，一横一竖）
    const forearmGap =
      Math.min(
        segmentDistance(lw, re, rw),
        segmentDistance(rw, le, lw),
        segmentDistance(le, re, rw),
        segmentDistance(re, le, lw),
      ) / scale
    const oneUpward = forearms.some(
      ([e, w], idx) => angles[idx]! > 50 && w.y < e.y - scale * 0.18,
    )
    const isBeamPose =
      !this.discArmed[0] &&
      !this.discArmed[1] &&
      minAngle < 40 &&
      maxAngle > 50 &&
      maxAngle - minAngle > 30 &&
      forearmGap < 0.58 &&
      inChestZone &&
      oneUpward

    const beamElapsed = this.beamHold.update(isBeamPose, now)
    const beamRequiredMs = 460
    if (isBeamPose || (beamElapsed > 0 && this.beamHold.isRecent(now))) {
      this.punchReady = [null, null]
      this.discRaiseStart = [null, null]
      this.discArmed = [null, null]
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

    // 3. 八分光轮（单手高举过头顶蓄力 → 向下或向前甩出）
    const nose = pts[0]
    const headTopY =
      isVisible(nose, 0.3) && nose.y < centerY - scale * 0.18
        ? nose.y - scale * 0.38
        : centerY - scale * 0.65

    for (let side = 0; side < 2; side++) {
      const wrist = side === 0 ? lw : rw
      const shoulder = side === 0 ? ls : rs
      const sideName: 'left' | 'right' = side === 0 ? 'left' : 'right'
      const relX = (wrist.x - shoulder.x) / scale
      const relY = (wrist.y - shoulder.y) / scale
      const relZ = (wrist.z - shoulder.z) / scale
      const isHigh = wrist.y < headTopY && angles[side]! > 48

      const armed = this.discArmed[side]
      if (armed) {
        if (now - armed.time > 2600) {
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
        if (drop > 0.36 && (forward > 0.08 || outward > 0.38 || drop > 0.72)) {
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
        const progress = clamp((now - this.discRaiseStart[side]!) / 300, 0, 1)
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

    // 4. 左右挥拳普攻连击
    this.detectPunch(pts, now, scale, out)
    return out
  }

  private detectPunch(pts: Vec3[], now: number, scale: number, out: GestureSnapshot) {
    let bestSide: 'left' | 'right' | null = null
    let bestScore = -Infinity

    for (let side = 0; side < 2; side++) {
      const s = pts[side === 0 ? 11 : 12]
      const e = pts[side === 0 ? 13 : 14]
      const w = pts[side === 0 ? 15 : 16]
      if (!isVisible(s, 0.35) || !isVisible(e, 0.35) || !isVisible(w, 0.28)) {
        this.punchReady[side] = null
        continue
      }

      const angle = elbowAngleDeg(s, e, w)
      const relX = (w.x - s.x) / scale
      const relY = (w.y - s.y) / scale
      const relZ = (w.z - s.z) / scale
      const inStrikeZone = relY > -0.55 && relY < 1.05

      // 蓄拳：手肘弯曲收在胸侧
      if (angle < 134 && inStrikeZone) {
        const prev = this.punchReady[side]
        if (!prev) {
          this.punchReady[side] = { time: now, relX, relY, relZ, angle }
        } else {
          prev.angle = Math.min(prev.angle, angle)
          if (relZ >= prev.relZ - 0.03) {
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
      if (!ready) continue
      if (!inStrikeZone || now - ready.time > 900) {
        this.punchReady[side] = null
        continue
      }

      const forward = ready.relZ - relZ
      const lateral = Math.abs(relX - ready.relX)
      const travel = Math.hypot(relX - ready.relX, relY - ready.relY, relZ - ready.relZ)
      const isStraight = angle > 136 && angle - ready.angle > 20
      const cooldownOk = now - this.punchLast[side]! > 240

      if (
        cooldownOk &&
        isStraight &&
        travel > 0.18 &&
        (forward > 0.1 || (travel > 0.36 && lateral < 0.7))
      ) {
        const score = forward + travel * 0.35
        if (score > bestScore) {
          bestScore = score
          // 注意镜像关系：MediaPipe 的 11/13/15 在镜像画面里对应人的右手/左手，
          // 屏幕内用户左拳对应人物左侧，直接以侧向自然反馈给奥特曼对应手臂即可
          bestSide = side === 0 ? 'right' : 'left'
        }
      }
    }

    if (bestSide) {
      const idx = bestSide === 'right' ? 0 : 1
      this.punchLast[idx] = now
      this.punchReady[idx] = null
      out.punch = bestSide
      out.hintKey = 'hintPunch'
    }
  }
}
