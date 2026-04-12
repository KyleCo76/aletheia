import crypto from 'crypto';
import type { AletheiaSettings } from '../lib/settings.js';
import { DEFAULTS } from '../lib/constants.js';

export class FrequencyManager {
  private callCount: number = 0;
  private l1Interval: number;
  private l2Interval: number;
  private l1CurrentInterval: number;
  private l2CurrentInterval: number;
  private lastL1Hash: string = '';
  private lastL2Hash: string = '';
  private bumpMultiplier: number;

  constructor(settings: AletheiaSettings) {
    this.l1Interval = settings.injection.l1Interval;
    this.l2Interval = settings.injection.l2Interval;
    this.l1CurrentInterval = this.l1Interval;
    this.l2CurrentInterval = this.l2Interval;
    this.bumpMultiplier = DEFAULTS.adaptiveNoChangeBumpMultiplier;
  }

  reset(): void {
    this.callCount = 0;
    this.l1CurrentInterval = this.l1Interval;
    this.l2CurrentInterval = this.l2Interval;
    this.lastL1Hash = '';
    this.lastL2Hash = '';
  }

  tick(): { injectL1: boolean; injectL2: boolean } {
    this.callCount++;

    const injectL1 = this.callCount % this.l1CurrentInterval === 0;
    const injectL2 = this.callCount % this.l2CurrentInterval === 0;

    return { injectL1, injectL2 };
  }

  updateHash(type: 'l1' | 'l2', payload: object | null): void {
    const data = payload ? JSON.stringify(payload) : '';
    const hash = crypto.createHash('sha256').update(data).digest('hex');

    if (type === 'l1') {
      if (hash === this.lastL1Hash) {
        // Single bump — don't continue escalating
        this.l1CurrentInterval = this.l1Interval * this.bumpMultiplier;
      } else {
        this.l1CurrentInterval = this.l1Interval;
      }
      this.lastL1Hash = hash;
    } else {
      if (hash === this.lastL2Hash) {
        this.l2CurrentInterval = this.l2Interval * this.bumpMultiplier;
      } else {
        this.l2CurrentInterval = this.l2Interval;
      }
      this.lastL2Hash = hash;
    }
  }
}
