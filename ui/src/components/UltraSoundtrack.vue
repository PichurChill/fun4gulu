<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ playing: boolean; muted: boolean }>()
const { t } = useI18n()
const track = ref('sortie')
const panel = ref(false)
const player = ref<HTMLAudioElement>()
const blocked = ref(false)
const albums: Record<string, string> = {
  dyna: 'https://embed.music.apple.com/jp/album/534110680?i=534110805',
  zeta: 'https://embed.music.apple.com/jp/album/1703538563?i=1703538564',
}

async function playScore() {
  const audio = player.value
  if (!audio) return
  audio.volume = 0.27
  try {
    await audio.play()
    blocked.value = false
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    blocked.value = true
  }
}
watch(() => [props.playing, props.muted, track.value], () => {
  if (props.playing && !props.muted && track.value === 'sortie') void playScore()
  else {
    player.value?.pause()
    blocked.value = false
    if (!props.playing && player.value) player.value.currentTime = 0
  }
})
onBeforeUnmount(() => player.value?.pause())
</script>

<template>
  <div class="soundtrack">
    <button class="music-toggle" :aria-expanded="panel" @click="panel = !panel">
      ♫ {{ t('message.ultramanView.music') }}
    </button>
    <div v-show="panel || (playing && !muted && albums[track]) || blocked" class="music-panel">
      <select v-show="panel" v-model="track" :aria-label="t('message.ultramanView.music')">
        <option value="sortie">{{ t('message.ultramanView.sortie') }}</option>
        <option value="dyna">TV · {{ t('message.ultramanView.heroNames.dyna') }}</option>
        <option value="zeta">TV · {{ t('message.ultramanView.heroNames.zeta') }}</option>
        <option value="off">{{ t('message.ultramanView.mute') }}</option>
      </select>
      <iframe v-if="playing && !muted && albums[track]" :key="track" :src="albums[track]"
        :title="t('message.ultramanView.music')" allow="autoplay; encrypted-media" />
      <button v-if="blocked" @click="playScore">▶ {{ t('message.ultramanView.music') }}</button>
    </div>
    <audio ref="player" src="/audio/ultraman/sortie.m4a" preload="none" loop />
  </div>
</template>

<style scoped>
.soundtrack { position: absolute; z-index: 55; right: 12px; bottom: 9px; color: white; }
.music-toggle,.music-panel select,.music-panel button { color: #e7f6ff; background: #152334; padding: 5px 10px; border: 1px solid #62778a; border-radius: 6px; cursor: pointer; }
.music-toggle { display: block; margin-left: auto; }
.music-panel { position: absolute; bottom: 100%; right: 0; display: grid; gap: 4px; padding: 6px; background: #101722; border-radius: 8px; }
iframe { border: 0; width: min(300px,80vw); height: 150px; }
</style>
