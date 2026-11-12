/**
 * App-wide singletons for the on-device stores, wired to AsyncStorage.
 * React-Native-only (imports AsyncStorage) — the store classes
 * themselves stay pure in myActions.ts / profileCustom.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AddressBookStore } from './addressBook';
import { BookmarkStore } from './bookmarks';
import { XFlowStore } from './exchangeFlows';
import { HuntersFlowStore } from './flows';
import { MyActionStore, type KVStorage } from './myActions';
import { ProfileCustomStore } from './profileCustom';

export const storeKV: KVStorage = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
};

export const myActionStore = new MyActionStore();
/** Saved posts (v0.6.0), per wallet address like myActionStore. */
export const bookmarkStore = new BookmarkStore();
export const profileCustomStore = new ProfileCustomStore();
export const huntersFlowStore = new HuntersFlowStore();
export const huntersSellFlowStore = new HuntersFlowStore(
  'caw-huntersflow-sell-',
);
export const addressBookStore = new AddressBookStore();
/** The one in-progress HuntersExchange deposit/withdraw flow. */
export const xFlowStore = new XFlowStore();
