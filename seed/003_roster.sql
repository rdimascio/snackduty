INSERT INTO participants (id, person_id, birth_date, status, created_at, updated_at) VALUES
  ('participant_seed_avery', 'person_seed_child_avery', date('now', '-7 hours', '-8 years', '-200 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('participant_seed_blake', 'person_seed_child_blake', date('now', '-7 hours', '-7 years', '-90 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('participant_seed_casey', 'person_seed_child_casey', date('now', '-7 hours', '-8 years', '-30 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('participant_seed_jordan', 'person_seed_child_jordan', date('now', '-7 hours', '-7 years', '-160 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('participant_seed_quinn', 'person_seed_child_quinn', date('now', '-7 hours', '-7 years', '-10 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO memberships (id, team_id, season_id, member_kind, member_person_id, member_participant_id, status, created_at, updated_at) VALUES
  ('membership_seed_falcons_avery', 'team_seed_falcons', 'season_seed_falcons', 'participant', NULL, 'participant_seed_avery', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('membership_seed_falcons_blake', 'team_seed_falcons', 'season_seed_falcons', 'participant', NULL, 'participant_seed_blake', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('membership_seed_falcons_casey', 'team_seed_falcons', 'season_seed_falcons', 'participant', NULL, 'participant_seed_casey', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('membership_seed_comets_jordan', 'team_seed_comets', 'season_seed_comets', 'participant', NULL, 'participant_seed_jordan', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('membership_seed_comets_quinn', 'team_seed_comets', 'season_seed_comets', 'participant', NULL, 'participant_seed_quinn', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES
  ('guardian_relationship_seed_parent_avery', 'person_seed_parent', 'participant_seed_avery', 'parent', 'active', '["participant.read","participant.manage"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guardian_relationship_seed_parent_blake', 'person_seed_parent', 'participant_seed_blake', 'parent', 'active', '["participant.read","participant.manage"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guardian_relationship_seed_placeholder_casey', 'person_seed_casey_guardian', 'participant_seed_casey', 'guardian', 'active', '["participant.read","participant.manage"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guardian_relationship_seed_second_adult_jordan', 'person_dev_second_adult', 'participant_seed_jordan', 'parent', 'active', '["participant.read","participant.manage"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guardian_relationship_seed_guardian_quinn', 'person_seed_second_team_guardian', 'participant_seed_quinn', 'parent', 'active', '["participant.read","participant.manage"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
