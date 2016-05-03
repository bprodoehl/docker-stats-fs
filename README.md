# docker-stats-fs

This library is based on the docker-stats library written by
Peter Elger <elger.peter@gmail.com> (http://peterelger.com/) and
Matteo Collina <matteo.collina@nearform.com>, but it draws the statistics
direct from the filesystem, as opposed to using the stats endpoint in the
Docker API.  This allows it to be selective about what stats to include, which
allows it to work comfortably with many, many running containers.
