export const SPRINKLE_KIND = 'slicc.sprinkle';

export interface Sprinkle {
  id: string;
  name: string;
  title: string;
  icon: string;
  agentId: string;
  html: string;
  inline?: boolean;
}
