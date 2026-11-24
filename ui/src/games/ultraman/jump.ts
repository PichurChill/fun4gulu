import type { PoseLandmark } from './types'

function visible(point?: PoseLandmark): point is PoseLandmark {
  return (
    !!point &&
    (point.visibility ?? 1) >= 0.45 &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  )
}

export function canTrackFeet(points: PoseLandmark[] | null): boolean {
  return !!points && [23, 24, 25, 26, 27, 28, 31, 32].every((index) => visible(points[index]))
}

/** 半身取景时，以双肩共同上升、到顶回落的轨迹推断跳跃。 */
export class JumpKickRecognizer {
  private standing: [number, number] | null = null
  private lastGroundTime = 0
  private peakRise = 0
  private lastFrame = -Infinity
  private fired = false

  public reset() {
    this.standing = null
    this.peakRise = 0
    this.fired = false
    this.lastFrame = -Infinity
  }

  public update(points: PoseLandmark[] | null, now: number, aspect: number): boolean {
    const left = points?.[11]
    const right = points?.[12]
    if (!visible(left) || !visible(right)) {
      this.reset()
      return false
    }
    if (now <= this.lastFrame || now - this.lastFrame > 400) this.reset()
    this.lastFrame = now
    const scale = Math.hypot((left.x - right.x) * aspect, left.y - right.y)
    if (!this.standing || scale <= 0) {
      this.standing = [left.y, right.y]
      this.lastGroundTime = now
      return false
    }

    const rise = Math.min(this.standing[0] - left.y, this.standing[1] - right.y) / scale
    // 只接受从站姿快速起跳的波峰，回落时出招，避免把慢慢站直当成跳跃。
    const elapsed = now - this.lastGroundTime
    if (elapsed <= 360) this.peakRise = Math.max(this.peakRise, rise)
    const jumped =
      !this.fired && elapsed <= 600 && this.peakRise >= 0.17 && this.peakRise - rise >= 0.035
    if (jumped) this.fired = true

    if (rise <= 0.055) {
      this.lastGroundTime = now
      this.peakRise = 0
      this.fired = false
    } else if (elapsed > 800) {
      // 超过一次跳跃的时间窗，从当前站位重新取样。
      this.fired = false
      this.standing = [left.y, right.y]
      this.lastGroundTime = now
      this.peakRise = 0
    }
    return jumped
  }
}
