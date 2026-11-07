/**
 * App-wide singletons for the on-device stores, wired to AsyncStorage.
 * React-Native-only (imports AsyncStorage) — the store classes
 * themselves stay pure in myActions.ts / profileCustom.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { HuntersFlowStore } from './flows';
import { MyActionStore, type KVStorage } from './myActions';
import { ProfileCustomStore } from './profileCustom';

export const storeKV: KVStorage = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
};

export const myActionStore = new MyActionStore();
export const profileCustomStore = new ProfileCustomStore();
export const huntersFlowStore = new HuntersFlowStore();
export const huntersSellFlowStore = new HuntersFlowStore(
  'caw-huntersflow-sell-',
);
