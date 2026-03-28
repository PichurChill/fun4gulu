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
        "jump-cat": {
          title: '跳跳猫',
          desc: '体感跳跃小游戏！站在摄像头前跳跃，小猫同步跳跃得分！'
        },
        "hurdle-cat": {
          title: '跨栏小猫',
          desc: '第一视角跨栏游戏！小猫持续前进，跳跃躲避栏杆！'
        },
        demo1: {
          title: '示例小游戏 1',
          desc: '一个简单的网页小游戏Demo。'
        },
        demo2: {
          title: '示例小游戏 2',
          desc: '探索未知的像素世界。'
        }
      },
      jumpCatView: {
        title: '跳跳猫',
        description: '站在摄像头前，跳跃得分！',
        startButton: '🎮 开始游戏',
        back: '返回',
        score: '分数',
        combo: '连击',
        debug: '调试',
        stop: '结束',
        calibrating: '请站在画面中间，校准中...'
      },
      hurdleCatView: {
        title: '跨栏小猫',
        description: '小猫一直在前进，跳跃躲避栏杆！',
        startButton: '🎮 开始游戏',
        back: '返回',
        score: '分数',
        combo: '连击',
        debug: '调试',
        stop: '结束',
        calibrating: '请站在画面中间，校准中...',
        controlMode: '控制模式',
        bodyMode: '身体',
        headMode: '头部',
        instructionsBody: '身体左右摆动切换车道，跳跃躲避栏杆',
        instructionsHead: '头部左右倾斜切换车道，点头跳跃躲避栏杆'
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
        "jump-cat": {
          title: 'Jump Cat',
          desc: 'A motion-sensing jumping game! Stand in front of the camera and jump!'
        },
        "hurdle-cat": {
          title: 'Hurdle Cat',
          desc: 'First-person hurdle game! The cat keeps moving forward, jump to avoid hurdles!'
        },
        demo1: {
          title: 'Demo Game 1',
          desc: 'A simple web game demo.'
        },
        demo2: {
          title: 'Demo Game 2',
          desc: 'Explore the unknown pixel world.'
        }
      },
      jumpCatView: {
        title: 'Jump Cat',
        description: 'Stand in front of the camera and jump to score!',
        startButton: '🎮 Start Game',
        back: 'BACK',
        score: 'SCORE',
        combo: 'COMBO',
        debug: 'DEBUG',
        stop: 'STOP',
        calibrating: 'Stand in center, calibrating...'
      },
      hurdleCatView: {
        title: 'Hurdle Cat',
        description: 'The cat keeps moving forward, jump to avoid hurdles!',
        startButton: '🎮 Start Game',
        back: 'BACK',
        score: 'SCORE',
        combo: 'COMBO',
        debug: 'DEBUG',
        stop: 'STOP',
        calibrating: 'Stand in center, calibrating...',
        controlMode: 'Control Mode',
        bodyMode: 'Body',
        headMode: 'Head',
        instructionsBody: 'Lean body to switch lanes, jump to avoid hurdles',
        instructionsHead: 'Tilt head to switch lanes, nod to jump'
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
        "jump-cat": {
          title: 'ジャンプ猫',
          desc: '体感ジャンプゲーム！カメラの前に立ってジャンプしよう！'
        },
        "hurdle-cat": {
          title: 'ハードル猫',
          desc: '一人称視点ハードルゲーム！猫が前に進み続け、ジャンプしてハードルを避けよう！'
        },
        demo1: {
          title: 'デモゲーム 1',
          desc: '簡単なWebゲームのデモ。'
        },
        demo2: {
          title: 'デモゲーム 2',
          desc: '未知のピクセル世界を探索しよう。'
        }
      },
      jumpCatView: {
        title: 'ジャンプ猫',
        description: 'カメラの前に立ってジャンプして得点！',
        startButton: '🎮 ゲームスタート',
        back: '戻る',
        score: 'スコア',
        combo: 'コンボ',
        debug: 'デバッグ',
        stop: '終了',
        calibrating: '画面の中央に立ってください、校正中...'
      },
      hurdleCatView: {
        title: 'ハードル猫',
        description: '猫が前に進み続け、ジャンプしてハードルを避けよう！',
        startButton: '🎮 ゲームスタート',
        back: '戻る',
        score: 'スコア',
        combo: 'コンボ',
        debug: 'デバッグ',
        stop: '終了',
        calibrating: '画面の中央に立ってください、校正中...',
        controlMode: 'コントロールモード',
        bodyMode: '体',
        headMode: '頭',
        instructionsBody: '体を左右に傾けてレーン変更、ジャンプしてハードルを回避',
        instructionsHead: '頭を左右に傾けてレーン変更、うなずいてジャンプ'
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
        "jump-cat": {
          title: '점프 고양이',
          desc: '체감 점프 게임! 카메라 앞에 서서 점프하세요!'
        },
        "hurdle-cat": {
          title: '허들 고양이',
          desc: '1인칭 허들 게임! 고양이가 계속 앞으로 나아가고, 점프하여 허들을 피하세요!'
        },
        demo1: {
          title: '데모 게임 1',
          desc: '간단한 웹 게임 데모.'
        },
        demo2: {
          title: '데모 게임 2',
          desc: '미지의 픽셀 세계를 탐험하세요.'
        }
      },
      jumpCatView: {
        title: '점프 고양이',
        description: '카메라 앞에 서서 점프하여 점수를 획득하세요!',
        startButton: '🎮 게임 시작',
        back: '뒤로',
        score: '점수',
        combo: '콤보',
        debug: '디버그',
        stop: '종료',
        calibrating: '화면 중앙에 서 주세요, 보정 중...'
      },
      hurdleCatView: {
        title: '허들 고양이',
        description: '고양이가 계속 앞으로 나아가고, 점프하여 허들을 피하세요!',
        startButton: '🎮 게임 시작',
        back: '뒤로',
        score: '점수',
        combo: '콤보',
        debug: '디버그',
        stop: '종료',
        calibrating: '화면 중앙에 서 주세요, 보정 중...',
        controlMode: '컨트롤 모드',
        bodyMode: '몸',
        headMode: '머리',
        instructionsBody: '몸을 좌우로 기울여 차선 변경, 점프하여 허들 회피',
        instructionsHead: '머리를 좌우로 기울여 차선 변경, 끄덕여 점프'
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
        "jump-cat": {
          title: 'Chat Sauteur',
          desc: 'Jeu de saut sensoriel ! Tenez-vous devant la caméra et sautez !'
        },
        "hurdle-cat": {
          title: 'Chat Haies',
          desc: 'Jeu de haies à la première personne ! Le chat avance constamment, sautez pour éviter les haies !'
        },
        demo1: {
          title: 'Jeu de Démo 1',
          desc: 'Une simple démo de jeu web.'
        },
        demo2: {
          title: 'Jeu de Démo 2',
          desc: 'Explorez le monde pixel inconnu.'
        }
      },
      jumpCatView: {
        title: 'Chat Sauteur',
        description: 'Tenez-vous devant la caméra et sautez pour marquer !',
        startButton: '🎮 Démarrer',
        back: 'Retour',
        score: 'Score',
        combo: 'Combo',
        debug: 'Débogage',
        stop: 'Arrêter',
        calibrating: 'Tenez-vous au centre, calibration en cours...'
      },
      hurdleCatView: {
        title: 'Chat Haies',
        description: 'Le chat avance constamment, sautez pour éviter les haies !',
        startButton: '🎮 Démarrer',
        back: 'Retour',
        score: 'Score',
        combo: 'Combo',
        debug: 'Débogage',
        stop: 'Arrêter',
        calibrating: 'Tenez-vous au centre, calibration en cours...',
        controlMode: 'Mode de contrôle',
        bodyMode: 'Corps',
        headMode: 'Tête',
        instructionsBody: 'Penchez le corps pour changer de voie, sautez pour éviter les haies',
        instructionsHead: 'Penchez la tête pour changer de voie, hochez la tête pour sauter'
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
