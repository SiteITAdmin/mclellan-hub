'use strict';

// Personal money screens under /crm/personal/money. Personal only: the Work
// space has no money screens and these paths 404 for it.

const money = require('../lib/crm/money');

module.exports = function mountMoney(router, helpers) {
  const personalOnly = (req, res, next) => {
    if (req.params.space !== 'personal') return res.status(404).send('Not found');
    next();
  };
  const h = { ...helpers, personalOnly, base: '/crm/personal/money' };
  router.use('/crm/:space/money', helpers.spaceParam, personalOnly);
  money.mount(router, h);
};
