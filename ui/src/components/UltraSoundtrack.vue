<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{
    playing: boolean
    muted: boolean
    inline?: boolean
  }>(),
  { inline: false },
)

const { t } = useI18n()
const track = ref('sortie')
const panel = ref(false)
const player = ref<HTMLAudioElement>()
const blocked = ref(false)
const rootRef = ref<HTMLElement | null>(null)
let playPromise: Promise<void> | null = null

const BASE_VOLUME = 0.26
let duckRestoreTimer: number | null = null

const albums: Record<string, string> = {
  dyna: 'https://embed.music.apple.com/jp/album/534110680?i=534110805',
  zeta: 'https://embed.music.apple.com/jp/album/1703538563?i=5341108564',
}

async function syncAudioPlayback() {
  const audio = player.value
  if (!audio) return
  const shouldPlay = props.playing && !props.muted && track.value === 'sortie'
  if (shouldPlay) {
    audio.volume = BASE_VOLUME
    try {
      playPromise = audio.play()
      await playPromise
      blocked.value = false
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      blocked.value = true
    } finally {
      playPromise = null
    }
  } else {
    if (playPromise) {
      try {
        await playPromise
      } catch {
        // 忽略挂起播放承诺的拦截异常
      }
    }
    if (!audio.paused) {
      audio.pause()
    }
    blocked.value = false
  }
}

function handleBgmDuck(e: Event) {
  const audio = player.value
  if (!audio || audio.paused || props.muted) return
  const detail = (e as CustomEvent<{ durationSec?: number; gain?: number }>).detail
  const duckGain = Math.max(0.05, Math.min(1, detail?.gain ?? 0.32))
  const durMs = Math.max(300, Math.round((detail?.durationSec ?? 1.4) * 1000))
  audio.volume = BASE_VOLUME * duckGain
  if (duckRestoreTimer !== null) window.clearTimeout(duckRestoreTimer)
  duckRestoreTimer = window.setTimeout(() => {
    duckRestoreTimer = null
    if (player.value && !player.value.paused && !props.muted) {
      player.value.volume = BASE_VOLUME
    }
  }, durMs)
}

function handleOutsideClick(e: MouseEvent) {
  if (!panel.value || !rootRef.value) return
  if (!rootRef.value.contains(e.target as Node)) {
    panel.value = false
  }
}

watch(
  () => [props.playing, props.muted, track.value],
  () => {
    void syncAudioPlayback()
  },
)

onMounted(() => {
  document.addEventListener('pointerdown', handleOutsideClick)
  window.addEventListener('ultra-bgm-duck', handleBgmDuck)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsideClick)
  window.removeEventListener('ultra-bgm-duck', handleBgmDuck)
  if (duckRestoreTimer !== null) window.clearTimeout(duckRestoreTimer)
  if (player.value && !player.value.paused) {
    player.value.pause()
  }
})
</script>

<template>
  <div ref="rootRef" class="soundtrack" :class="{ inline }">
    <button
      type="button"
      class="music-toggle"
      :class="{ active: panel || blocked }"
      :aria-expanded="panel"
      @click.stop="panel = !panel"
    >
      <svg class="note-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <span>{{ t('message.ultramanView.music') }}</span>
    </button>
    <div
      v-show="panel || (playing && !muted && albums[track]) || blocked"
      class="music-panel"
      @click.stop
    >
      <select v-show="panel" v-model="track" :aria-label="t('message.ultramanView.music')">
        <option value="sortie">{{ t('message.ultramanView.sortie') }}</option>
        <option value="dyna">TV · {{ t('message.ultramanView.heroNames.dyna') }}</option>
        <option value="zeta">TV · {{ t('message.ultramanView.heroNames.zeta') }}</option>
        <option value="off">{{ t('message.ultramanView.mute') }}</option>
      </select>
      <iframe
        v-if="playing && !muted && albums[track]"
        :key="track"
        :src="albums[track]"
        :title="t('message.ultramanView.music')"
        allow="autoplay; encrypted-media"
      />
      <button v-if="blocked" type="button" class="unlock-btn" @click="syncAudioPlayback">
        <svg class="play-svg" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2.5l10 5.5-10 5.5V2.5z" />
        </svg>
        <span>{{ t('message.ultramanView.music') }}</span>
      </button>
    </div>
    <audio ref="player" src="/audio/ultraman/sortie.m4a" preload="none" loop />
  </div>
</template>

<style scoped>
.soundtrack {
  position: relative;
  display: inline-flex;
  align-items: center;
  z-index: 60;
}

.soundtrack:not(.inline) {
  position: fixed;
  right: 16px;
  bottom: 14px;
}

.music-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  color: #e2f1ff;
  background: rgba(11, 22, 38, 0.88);
  border: 1px solid rgba(56, 232, 255, 0.42);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.music-toggle:hover,
.music-toggle.active {
  border-color: #38e8ff;
  background: rgba(20, 42, 68, 0.95);
  color: #7dd3fc;
}

.note-svg {
  width: 14px;
  height: 14px;
  color: #facc15;
  flex-shrink: 0;
}

.play-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.music-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 190px;
  display: grid;
  gap: 6px;
  padding: 8px;
  background: rgba(9, 18, 32, 0.96);
  border: 1px solid rgba(56, 232, 255, 0.55);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.65);
  z-index: 80;
}

.soundtrack:not(.inline) .music-panel {
  top: auto;
  bottom: calc(100% + 6px);
}

.music-panel select,
.unlock-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #e7f6ff;
  background: #132338;
  padding: 6px 10px;
  border: 1px solid rgba(125, 211, 252, 0.45);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

iframe {
  border: 0;
  width: min(290px, 78vw);
  height: 150px;
}
</style>
