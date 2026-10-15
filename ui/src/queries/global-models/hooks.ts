import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { referencesOptions, vramOptions } from './options';

export const useVram = () => useQuery(vramOptions());
export function useReferences() {
  const client = useQueryClient();
  const query = useQuery(referencesOptions());
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: referencesOptions().queryKey }), [client]);
  return { references: query.data?.references ?? [], refresh };
}
