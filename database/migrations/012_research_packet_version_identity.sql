-- Research packet IDs are stable across immutable versions. The original
-- primary key on id alone prevented version 2+ from being inserted even
-- though (topic_id, packet_version) was already the version identity.
-- Changing the key constraint preserves every existing row and payload.
alter table content_machine.research_packets
  drop constraint research_packets_pkey,
  add constraint research_packets_pkey primary key (id, packet_version);

comment on constraint research_packets_pkey on content_machine.research_packets is
  'Stable packet identity plus immutable packet version; topic_id and packet_version remain independently unique.';
