export function GameSymbol({ kind }: { kind: 'speed' | 'bluff' | 'strategy' }) {
  const symbols = {
    speed: <><circle cx="40" cy="45" r="25" /><path d="M40 26v19l12-8M32 10h16M40 10v9M60 24l6-6" /><circle cx="40" cy="45" r="3" /></>,
    bluff: <><rect x="12" y="19" width="40" height="48" rx="7" transform="rotate(-12 32 43)" /><rect x="31" y="15" width="39" height="49" rx="7" transform="rotate(10 50 40)" /><path d="M44 32c0-10 16-9 16 0 0 5-8 6-8 12M52 52v1" /></>,
    strategy: <><path d="M19 16h43v47H19zM19 31h43M19 47h43M33 16v47M48 16v47" /><path d="m28 55 13-16 9 5 12-19" /><path d="m53 25 9-1 1 9" /></>,
  };
  return <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{symbols[kind]}</svg>;
}
