/**
 * Picking and storing profile pictures on the device (React Native
 * only). The picked photo is COPIED into the app's own document
 * folder — the picker hands out temporary/cache URIs that can vanish,
 * while the copy stays as long as the app is installed.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

function profileDir(): Directory {
  const dir = new Directory(Paths.document, 'profile-images');
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

/**
 * Let the user pick one picture and store a copy for this name.
 * Returns the stored file URI, or null when they cancelled / denied.
 */
export async function pickAndStoreProfileImage(
  tokenId: bigint,
  kind: 'avatar' | 'header',
): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: kind === 'avatar' ? [1, 1] : [3, 1],
    quality: 0.85,
  });
  if (res.canceled || !res.assets || res.assets.length === 0) return null;
  const asset = res.assets[0];
  const ext =
    asset.mimeType && asset.mimeType.toLowerCase().includes('png')
      ? 'png'
      : 'jpg';
  const dest = new File(
    profileDir(),
    tokenId.toString() + '-' + kind + '.' + ext,
  );
  await new File(asset.uri).copy(dest, { overwrite: true });
  return dest.uri;
}

/** Delete a stored profile picture copy (best effort). */
export function deleteProfileImage(path?: string): void {
  if (!path) return;
  try {
    const f = new File(path);
    if (f.exists) f.delete();
  } catch {
    /* best effort — a leftover file in our own folder is harmless */
  }
}
