import type { SocialPlatform, SocialPublisherCapabilities } from "./models";
import type { SocialPublisher } from "./interfaces";

const manualCapabilities: SocialPublisherCapabilities = {
  canAutoPost: false,
  supportsImages: true,
  supportsCarousel: true,
  supportsThreads: true,
  supportsDrafts: true,
};

/** Safe fallback: it describes export capabilities but can never claim a post. */
export class ManualSocialPublisher implements SocialPublisher {
  readonly id = "manual";
  readonly platform = "manual" as const;
  capabilities() {
    return manualCapabilities;
  }
  isConfigured() {
    return true;
  }
  async publish() {
    return { confirmed: false };
  }
}

export class SocialPublisherRegistry {
  private readonly manual = new ManualSocialPublisher();
  constructor(private readonly publishers: SocialPublisher[] = []) {}

  for(platform: SocialPlatform): SocialPublisher {
    return (
      this.publishers.find(
        (publisher) =>
          publisher.platform === platform && publisher.isConfigured(),
      ) ?? this.manual
    );
  }

  capabilities(platform: SocialPlatform) {
    const publisher = this.for(platform);
    return {
      provider: publisher.id,
      configured: publisher.isConfigured(),
      ...publisher.capabilities(),
    };
  }
}
