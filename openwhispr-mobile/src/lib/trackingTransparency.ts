// Telemetry disabled in this build. Original implementation retained below.
export type TrackingAuthorizationStatus =
  'authorized' | 'denied' | 'notDetermined' | 'notSupported';

// Attribution is disabled, so never read or request the native tracking permission.
export async function getTrackingAuthorizationStatus(): Promise<TrackingAuthorizationStatus> {
  return 'notSupported';
}

export async function requestTrackingAuthorization(): Promise<TrackingAuthorizationStatus> {
  return 'notSupported';
}

/*
import { Platform } from 'react-native';
import {
  getTrackingPermissionsAsync,
  isAvailable,
  requestTrackingPermissionsAsync,
  type PermissionResponse,
} from 'expo-tracking-transparency';

export type TrackingAuthorizationStatus =
  | 'authorized'
  | 'denied'
  | 'notDetermined'
  | 'notSupported';

function mapPermissionStatus(
  status: PermissionResponse['status'],
): Exclude<TrackingAuthorizationStatus, 'notSupported'> {
  if (status === 'granted') return 'authorized';
  if (status === 'denied') return 'denied';
  return 'notDetermined';
}

export async function getTrackingAuthorizationStatus(): Promise<TrackingAuthorizationStatus> {
  if (Platform.OS !== 'ios' || !isAvailable()) return 'notSupported';
  const response = await getTrackingPermissionsAsync();
  return mapPermissionStatus(response.status);
}

export async function requestTrackingAuthorization(): Promise<TrackingAuthorizationStatus> {
  if (Platform.OS !== 'ios' || !isAvailable()) return 'notSupported';
  const response = await requestTrackingPermissionsAsync();
  return mapPermissionStatus(response.status);
}
*/
