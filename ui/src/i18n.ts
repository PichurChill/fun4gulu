import { createI18n } from 'vue-i18n'

const messages = {
  zh: {
    message: {
      title: 'Fun4Gulu 游戏合集',
      home: '回到首页',
      nav_games: '按【↓】查看游戏列表',
      games_list: '🎮 游戏列表',
      play: '开始',
      language: '选择语言:',
      welcome: '欢迎来到复古红白机游戏世界！',
      loading: '加载中...',
      coming_soon: '更多游戏，敬请期待...',
      games: {
        demo1: {
          title: '示例小游戏 1',
          desc: '一个简单的网页小游戏Demo。'
        },
        demo2: {
          title: '示例小游戏 2',
          desc: '探索未知的像素世界。'
        }
      }
    }
  },
  en: {
    message: {
      title: 'Fun4Gulu Game Collection',
      home: 'Back Home',
      nav_games: 'Press [↓] to view games',
      games_list: '🎮 Game List',
      play: 'Start',
      language: 'Language:',
      welcome: 'Welcome to the retro 8-bit game world!',
      loading: 'Loading...',
      coming_soon: 'More games coming soon...',
      games: {
        demo1: {
          title: 'Demo Game 1',
          desc: 'A simple web game demo.'
        },
        demo2: {
          title: 'Demo Game 2',
          desc: 'Explore the unknown pixel world.'
        }
      }
    }
  },
  ja: {
    message: {
      title: 'Fun4Gulu ゲームコレクション',
      home: 'ホームへ戻る',
      nav_games: '【↓】を押してゲームリストを見る',
      games_list: '🎮 ゲームリスト',
      play: 'スタート',
      language: '言語選択:',
      welcome: 'レトロな8ビットゲームの世界へようこそ！',
      loading: 'ロード中...',
      coming_soon: 'もっと多くのゲームをお楽しみに...',
      games: {
        demo1: {
          title: 'デモゲーム 1',
          desc: '簡単なWebゲームのデモ。'
        },
        demo2: {
          title: 'デモゲーム 2',
          desc: '未知のピクセル世界を探索しよう。'
        }
      }
    }
  },
  ko: {
    message: {
      title: 'Fun4Gulu 게임 컬렉션',
      home: '홈으로',
      nav_games: '[↓] 눌러 게임 목록 보기',
      games_list: '🎮 게임 목록',
      play: '시작',
      language: '언어:',
      welcome: '레트로 8비트 게임 세계에 오신 것을 환영합니다!',
      loading: '로딩 중...',
      coming_soon: '더 많은 게임이 곧 제공됩니다...',
      games: {
        demo1: {
          title: '데모 게임 1',
          desc: '간단한 웹 게임 데모.'
        },
        demo2: {
          title: '데모 게임 2',
          desc: '미지의 픽셀 세계를 탐험하세요.'
        }
      }
    }
  },
  fr: {
    message: {
      title: 'Collection de jeux Fun4Gulu',
      home: 'Accueil',
      nav_games: 'Appuyez sur [↓] pour voir les jeux',
      games_list: '🎮 Liste de jeux',
      play: 'Jouer',
      language: 'Langue:',
      welcome: 'Bienvenue dans le monde du jeu rétro 8 bits !',
      loading: 'Chargement...',
      coming_soon: 'Plus de jeux à venir...',
      games: {
        demo1: {
          title: 'Jeu de Démo 1',
          desc: 'Une simple démo de jeu web.'
        },
        demo2: {
          title: 'Jeu de Démo 2',
          desc: 'Explorez le monde pixel inconnu.'
        }
      }
    }
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  fallbackLocale: 'en',
  messages,
})
