-- ES-154 / ES-156: getting-started checklist progress and walkthrough analytics events.
CREATE TABLE IF NOT EXISTS onboarding_progress (
    user_id integer NOT NULL,
    item varchar(60) NOT NULL,
    done_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, item)
);

CREATE TABLE IF NOT EXISTS onboarding_events (
    id bigserial PRIMARY KEY,
    user_id integer NOT NULL,
    username varchar(100),
    event varchar(20) NOT NULL,
    step varchar(50),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_event_step ON onboarding_events (event, step);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_user ON onboarding_events (user_id);
