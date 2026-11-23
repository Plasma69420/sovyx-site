export const S = {
  user: null,
  data: null,
  plan: 'free',
  apps: [],
  panels: [],
  app: null,
  view: 'overview',
};

export const LIMITS = {
  free:     { apps: 1,        licenses: 25 },
  basic:    { apps: 2,        licenses: 1000 },
  pro:      { apps: 5,        licenses: 10000 },
  ultimate: { apps: Infinity, licenses: Infinity },
};

export const PLAN_FEATURES = {
  free:     ['1 application', '25 licenses', 'Users & live sessions', 'HWID lock'],
  basic:    ['2 applications', '1,000 licenses', 'API keys & C++ SDK', 'Everything in Free'],
  pro:      ['5 applications', '10,000 licenses', 'Webhooks, variables, blacklist', 'Everything in Basic'],
  ultimate: ['Unlimited applications', 'Unlimited licenses', 'Reseller panel & Discord bot', 'Everything in Pro'],
};

// Views register a loader here; it runs when the view opens or the app changes.
export const loaders = {};
