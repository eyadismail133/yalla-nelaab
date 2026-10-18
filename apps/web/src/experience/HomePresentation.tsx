import type { ReactNode } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS } from '@game/shared';
import { getRoundType, ROUND_TYPES } from '@game/rounds';
import { CATEGORIES } from '../content/index.js';
import { BrandLogo } from '../ui/BrandLogo.js';
import { GameSymbol } from '../ui/GameSymbol.js';

export function HomeHeader() {
  return (
    <header className="home-header">
      <BrandLogo />
      <nav aria-label="روابط الصفحة" className="home-nav">
        <a href="#game-modes">ألعاب الليلة</a>
        <a href="#game-guide">إزاي نلعب؟</a>
      </nav>
      <a className="header-start" href="#start-playing">ابدأ اللعب <span aria-hidden="true">↗</span></a>
    </header>
  );
}

export function HomeHero({ children }: { children: ReactNode }) {
  return (
    <section className="home-hero" aria-labelledby="home-heading">
      <div className="home-hero-copy">
        <p className="hero-eyebrow"><span aria-hidden="true" /> للصحبة اللي بتحب التحدّي</p>
        <h1 id="home-heading">لمّ صحابك.<br /><span>خلّوا القعدة تحلى!</span></h1>
        <p className="hero-description">مش مجرد أسئلة. سرعة، خداع، وتحديات تقلب الترتيب.<br />كل واحد بموبايله… والكل في نفس الحكاية.</p>
        {children}
      </div>
      <div className="hero-visual" aria-hidden="true">
        <img src="/brand/challenge-kit-1200.webp" srcSet="/brand/challenge-kit-640.webp 640w, /brand/challenge-kit-1200.webp 1200w"
          sizes="(max-width: 800px) calc(100vw - 40px), 50vw" width="1200" height="800"
          alt="" decoding="async" fetchPriority="high" />
      </div>
    </section>
  );
}

export function HomeStats() {
  return (
    <ul className="home-stats" aria-label="عن اللعبة">
      <li><strong className="tabular">{ROUND_TYPES.length}<span>لعبة</span></strong><p>كل جولة بطعم مختلف</p></li>
      <li><strong className="tabular"><bdi>{MIN_PLAYERS}–{MAX_PLAYERS}</bdi><span>لاعيبة</span></strong><p>أصحاب، أهل، أو شلّة كاملة</p></li>
      <li><strong className="tabular">{CATEGORIES.length}<span>مجال</span></strong><p>من الكورة للسينما والعلوم</p></li>
      <li><strong>على طول<span aria-hidden="true">↗</span></strong><p>من غير حساب ولا تحميل</p></li>
    </ul>
  );
}

const FEATURED_GAMES = [
  { id: 'mcq_race', icon: 'speed', label: 'للي بيسبق الكل', detail: 'الإجابة الصح مهمة. بس السرعة بتفرق في الصدارة.' },
  { id: 'fibbing', icon: 'bluff', label: 'للي بيعرف يقنع', detail: 'اكتب كذبة مقنعة، واقفش الحقيقة وسط إجابات صحابك.' },
  { id: 'ordering', icon: 'strategy', label: 'للي بيفكر لقدّام', detail: 'رتّب الإجابات صح. كل اختيار في مكانه يقرّبك للمكسب.' },
] as const;

export function HomeGameModes() {
  return (
    <section id="game-modes" className="home-modes" aria-labelledby="modes-heading">
      <div className="section-heading"><div><p className="section-eyebrow">كل واحد وليه لعبته</p><h2 id="modes-heading">إنت أنهي نوع منافس؟</h2></div><a href="#game-guide">استكشف كل الألعاب <span aria-hidden="true">↙</span></a></div>
      <div className="mode-grid">
        {FEATURED_GAMES.map((game, index) => <article className={`mode-card mode-card--${game.icon}`} key={game.id}>
          <div className="mode-card-top"><span>{game.label}</span><span className="tabular" aria-hidden="true">0{index + 1}</span></div>
          <div className="mode-card-art"><GameSymbol kind={game.icon} /><span className="mode-orbit" aria-hidden="true" /></div>
          <h3>{getRoundType(game.id).nameAr}</h3><p>{game.detail}</p>
        </article>)}
      </div>
    </section>
  );
}

export function HomeFooter() {
  return (
    <footer className="home-footer">
      <BrandLogo compact />
      <p>صحبة حلوة. منافسة أحلى.</p>
      <a href="#start-playing">جاهز للتحدّي؟ <span aria-hidden="true">↑</span></a>
    </footer>
  );
}
