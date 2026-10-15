import { queryOptions, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { songApi } from '../../services/api';
import { sharedKeys } from '../keys';

// Stage 2a reads shared wire shapes through canonical keys until shell-queue
// publishes its hooks. Credentials are captured by the function, never the key.
export const songsOptions = (token: string) => queryOptions({
  queryKey: sharedKeys.songs(),
  queryFn: ({ signal }) => songApi.list(token, { signal }),
});
export function useStudioSongs(enabled = true) {
  const { token, sessionEpoch } = useAuth();
  void sessionEpoch;
  return useQuery({ ...songsOptions(token || ''), enabled: enabled && !!token });
}
export { aceModelsOptions as modelsOptions } from '../global-models/options';
