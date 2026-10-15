import { queryOptions, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { songApi } from '../../services/api';
import { apiClient } from '../../services/httpClient';
import type { PluginRegistry } from '../../types/pluginTypes';
import { sharedKeys } from '../keys';

// Shared reads retain their canonical wire shapes. Credentials are captured
// by the function, never the key; observers own selection and polling cadence.
export const songsOptions = (token: string) => queryOptions({
  queryKey: sharedKeys.songs(),
  queryFn: ({ signal }) => songApi.list(token, { signal }),
});
export function useStudioSongs(enabled = true) {
  const { token, sessionEpoch } = useAuth();
  void sessionEpoch;
  return useQuery({ ...songsOptions(token || ''), enabled: enabled && !!token });
}
export const studioPluginsOptions = () => queryOptions({
  queryKey: sharedKeys.plugins(),
  queryFn: ({ signal }) => apiClient.get<PluginRegistry>('/plugins', { signal }),
});
export { aceModelsOptions as modelsOptions } from '../global-models/options';
