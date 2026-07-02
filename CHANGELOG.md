# Changelog

All notable changes to this connector are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.3

- Converted the connector to the schema-config surface: configuration renders from a declared config schema instead of a custom React page, configuring fully at runtime with no image rebuild.
- Removed the extension-rendered connection-status pill.
- Re-publishing restores the connector's registry metadata that a prior publisher bug had stripped, fixing installation.
