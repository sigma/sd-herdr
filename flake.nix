{
  description = "sd-herdr dev environment (firefly-engineering/toolbox)";

  inputs = {
    nix-pins.url = "github:firefly-engineering/nix-pins";
    nixpkgs.follows = "nix-pins/nixpkgs";
    toolbox.url = "github:firefly-engineering/toolbox";
    toolbox.inputs.nix-pins.follows = "nix-pins";
  };

  outputs =
    { nixpkgs, toolbox, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          reg = toolbox.registry.${system};

          # Resolve a toolbox package at its default version.
          tool = name: reg.${name}.versions.${reg.${name}.default};
        in
        {
          # typescript-toolchain bundles nodejs, pnpm, typescript, biome and bun
          # (all pinned) — the JS/TS driver for this repo. The `streamdeck` CLI
          # comes from pnpm (@elgato/cli), not nix; the shellHook puts pnpm's
          # bin dir on PATH so `streamdeck` is a plain command in the shell.
          default = pkgs.mkShell {
            packages = [
              (tool "typescript-toolchain")
              (tool "just")
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              if [ ! -d "$PWD/node_modules" ]; then
                echo "sd-herdr: node_modules is missing — run 'just install' before 'just build' or 'just link'." >&2
              fi
            '';
          };
        }
      );
    };
}
