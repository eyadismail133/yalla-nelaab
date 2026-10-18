import { Component, type ReactNode } from 'react';
import { Button, Screen } from './primitives.js';

/** Refresh keeps the stored seat when an old tab references a replaced deployment chunk. */
export class ScreenLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <Screen className="justify-center text-center">
      <p role="alert">تعذر تحميل الشاشة — حدّث الصفحة عشان ترجع لمقعدك.</p>
      <Button onClick={() => window.location.reload()}>تحديث الصفحة</Button>
    </Screen>;
  }
}
