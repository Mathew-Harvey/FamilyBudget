-- A job change makes historical income a poor guide to future income, so the
-- forecast needs to be told what to expect rather than inferring it. Null means
-- fall back to what recent periods actually did.
alter table pay_cycle
  add column expected_income numeric(12,2);
