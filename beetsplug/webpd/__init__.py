# This file is part of beets.
# Copyright 2013, Adrian Sampson.
#
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.

"""A Web interface to beets."""
from beets.plugins import BeetsPlugin
from beets import ui

# Plugin hook.

class WebPlayerDaemonPlugin(BeetsPlugin):
    def __init__(self):
        super(WebPlayerDaemonPlugin, self).__init__()
        self.config.add({
            'host': u'',
            'port': 8338,
        })

    def commands(self):
        cmd = ui.Subcommand('webpd',
                            help='run a player on this device with a web UI')
        cmd.parser.add_option('-d', '--debug', action='store_true',
                              default=False, help='debug mode')
        def func(lib, opts, args):
            args = ui.decargs(args)
            if args:
                self.config['host'] = args.pop(0)
            if args:
                self.config['port'] = int(args.pop(0))

            from beetsplug.webpd.server import run_server

            run_server(lib,
                       host=self.config['host'].get(unicode),
                       port=self.config['port'].get(int),
                       debug=opts.debug)
        cmd.func = func
        return [cmd]
