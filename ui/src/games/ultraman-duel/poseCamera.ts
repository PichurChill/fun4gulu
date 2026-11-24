import type { PoseLandmark } from '../ultraman/types'

/** 单个识别到的人：33 点骨骼 + 镜像屏幕坐标下的水平中心（越小越靠画面左） */
export interface DetectedPose {
  landmarks: PoseLandmark[]
  worldLandmarks: PoseLandmark[]
  mirroredCenterX: number
}

// 注意：jsdelivr 上不存在 0.10.22 等旧版本号，必须使用实际存在的发布版本（如 1.2.3）
const TASKS_VISION_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs'
const TASKS_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

interface TasksVisionModule {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> }
  PoseLandmarker: {
    createFromOptions(fileset: unknown, opts: Record<string, unknown>): Promise<PoseLandmarkerLike>
  }
}

interface PoseLandmarkerLike {
  detectForVideo(
    video: HTMLVideoElement,
    timestamp: number,
  ): {
    landmarks?: { x: number; y: number; z?: number; visibility?: number }[][]
    worldLandmarks?: { x: number; y: number; z?: number; visibility?: number }[][]
  }
  close(): void
}

/**
 * 双人姿态摄像头：MediaPipe Tasks Vision PoseLandmarker（numPoses = 2）
 * 一个摄像头同时识别左右两人，按镜像画面水平位置排序输出（左 = P1，右 = P2）
 */
export class MultiPoseCamera {
  private landmarker: PoseLandmarkerLike | null = null
  private stream: MediaStream | null = null
  private session = 0
  public onError: ((error: unknown) => void) | null = null
  private rafId = 0
  private lastVideoTime = -1
  /** 每帧回调：已按镜像水平位置升序排列（最多 2 人） */
  public onPoses: ((poses: DetectedPose[], now: number) => void) | null = null

  public async start(video: HTMLVideoElement): Promise<void> {
    if (!video) throw new Error('Video element unavailable')

    const session = ++this.session
    const vision = (await import(/* @vite-ignore */ TASKS_VISION_URL)) as unknown as TasksVisionModule
    const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_WASM_URL)
    if (session !== this.session) return
    const landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 2,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    })

    if (session !== this.session) {
      landmarker.close()
      return
    }
    this.landmarker = landmarker
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
    if (session !== this.session) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    this.stream = stream
    video.srcObject = stream
    await video.play()
    if (session !== this.session) return

    const loop = () => {
      this.rafId = requestAnimationFrame(loop)
      if (!this.landmarker || video.readyState < 2) return
      if (video.currentTime === this.lastVideoTime) return
      this.lastVideoTime = video.currentTime
      try {
        this.detect(video)
      } catch (error) {
        this.stop(video)
        if (!this.onError) throw error
        this.onError(error)
      }
    }
    this.rafId = requestAnimationFrame(loop)
  }

  private detect(video: HTMLVideoElement) {
    const lm = this.landmarker
    if (!lm) return
    const res = lm.detectForVideo(video, performance.now())
    const lmSets = res.landmarks ?? []
    const worldSets = res.worldLandmarks ?? []
    const poses: DetectedPose[] = []

    for (let i = 0; i < lmSets.length && poses.length < 2; i++) {
      const raw = lmSets[i]!
      if (raw.length < 33) continue
      const landmarks: PoseLandmark[] = raw.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z ?? 0,
        visibility: p.visibility ?? 1,
      }))
      const worldRaw = worldSets[i] ?? []
      const worldLandmarks: PoseLandmark[] =
        worldRaw.length >= 33
          ? worldRaw.map((p, index) => ({ x: p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? landmarks[index]!.visibility }))
          : []
      const ls = raw[11]!
      const rs = raw[12]!
      // 画面镜像显示：屏幕左 = 1 - 原始 x
      const mirroredCenterX = 1 - (ls.x + rs.x) / 2
      poses.push({ landmarks, worldLandmarks, mirroredCenterX })
    }

    poses.sort((a, b) => a.mirroredCenterX - b.mirroredCenterX)
    this.onPoses?.(poses, performance.now())
  }

  public stop(video: HTMLVideoElement | null) {
    this.session++
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.lastVideoTime = -1
    if (this.landmarker) {
      try {
        this.landmarker.close()
      } catch {
        // 关闭过程中的浏览器状态异常可忽略
      }
      this.landmarker = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((tr) => tr.stop())
      this.stream = null
    }
    if (video) {
      video.srcObject = null
    }
  }
}
