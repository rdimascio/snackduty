INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES
  ('team_seed_falcons', 'Scenario Falcons', 'active', 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('team_seed_comets', 'Scenario Comets', 'active', 'person_dev_adult', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO seasons (id, team_id, label, start_date, end_date, time_zone, status, created_at, updated_at, lesson_age_band) VALUES
  ('season_seed_falcons', 'team_seed_falcons', 'Fall season', date('now', '-7 hours', '-30 days'), date('now', '-7 hours', '+120 days'), 'America/Phoenix', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
  ('season_seed_comets', 'team_seed_comets', 'Fall season', date('now', '-7 hours', '-30 days'), date('now', '-7 hours', '+120 days'), 'America/Phoenix', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);

INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES
  ('adult_membership_seed_falcons_co_coach', 'team_seed_falcons', 'person_seed_co_coach', 'coach', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('adult_membership_seed_falcons_second_adult', 'team_seed_falcons', 'person_dev_second_adult', 'coach', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('adult_membership_seed_falcons_parent', 'team_seed_falcons', 'person_seed_parent', 'adult', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('adult_membership_seed_falcons_team_member', 'team_seed_falcons', 'person_seed_team_member', 'adult', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('adult_membership_seed_comets_second_adult', 'team_seed_comets', 'person_dev_second_adult', 'adult', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('adult_membership_seed_comets_guardian', 'team_seed_comets', 'person_seed_second_team_guardian', 'adult', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
